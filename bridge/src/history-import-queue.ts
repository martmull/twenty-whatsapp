import { randomUUID } from 'node:crypto';

import { EncryptedJsonStore } from './encrypted-json-store.js';
import type { MessageEvent } from './message-event.js';

// Twenty imports selected history in a chain of background jobs, one page per job. This queue holds
// what is left to import and makes sure only one chain runs: each job must present the current run
// token, so a duplicate chain (a job retried, or a lost chain replaced) stops at its next claim.

export const MAX_PAGE_MESSAGES = 100;
export const MAX_PAGE_MEDIA = 5;
const LEASE_MS = 6 * 60_000;
// A chain that missed its scheduled run by this much is considered lost and can be resumed.
const STALL_GRACE_MS = 3 * 60_000;
const MAX_FAILURES = 5;
// Finished and failed chats stay listed so progress covers the whole run, then are cleared by the
// next run or after this long.
const FINISHED_TASK_RETENTION_MS = 24 * 60 * 60_000;

type Cursor = { sentAt: string; eventId: string };

export type HistoryImportTask = {
  taskId: string;
  chatId: string;
  conversationId: string;
  since: string;
  cursor?: Cursor;
  imported: number;
  // Messages handled so far, imported or already in Twenty: what the progress bar shows.
  processed: number;
  total: number;
  failures: number;
  queuedAt: string;
  doneAt?: string;
  failedAt?: string;
};

export type HistoryImportPage = {
  leaseId: string;
  chatId: string;
  conversationId: string;
  messages: MessageEvent[];
  isLastPage: boolean;
  // Sent with the last page, so the conversation summary is written once per chat.
  summary?: { lastMessage?: MessageEvent; lastInboundAt?: string };
};

export type HistoryImportProgress = {
  chatId: string;
  imported: number;
  processed: number;
  total: number;
  state: 'queued' | 'done' | 'failed';
};

type ClaimResult = HistoryImportPage | { stale: true } | { done: true };

type HistoryImportQueueOptions = {
  now?: () => number;
  // Called with a new run token when a lost chain is replaced; Twenty must start a job with it.
  onChainRestarted?: (runToken: string) => void;
  // A chain is only restarted while WhatsApp is connected, since its jobs could not claim pages.
  canRun?: () => boolean;
};

const isAfter = (message: MessageEvent, cursor?: Cursor) =>
  !cursor ||
  message.sentAt > cursor.sentAt ||
  (message.sentAt === cursor.sentAt && message.eventId.localeCompare(cursor.eventId) > 0);

export class HistoryImportQueue {
  private readonly tasks: EncryptedJsonStore<HistoryImportTask>;
  private runToken: string | undefined;
  private nextRunAt: number | undefined;
  private lease:
    | { id: string; taskId: string; chatId: string; expiresAt: number; messages: MessageEvent[]; isLastPage: boolean }
    | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private stallTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly onChainRestarted: (runToken: string) => void;
  private readonly canRun: () => boolean;

  constructor(
    directory: string,
    encryptionKey: Buffer,
    // Messages of a chat sorted by sentAt then eventId, as kept in the history cache.
    private readonly readMessages: (chatId: string) => Promise<MessageEvent[] | undefined>,
    { now = Date.now, onChainRestarted = () => undefined, canRun = () => true }: HistoryImportQueueOptions = {},
  ) {
    this.tasks = new EncryptedJsonStore(directory, encryptionKey);
    this.now = now;
    this.onChainRestarted = onChainRestarted;
    this.canRun = canRun;
  }

  // Checks again once the chain's next step is overdue, so a lost job never stalls the import.
  private armStallCheck(expectedInMs: number): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => void this.recoverStalled(), Math.max(0, expectedInMs) + STALL_GRACE_MS);
    this.stallTimer.unref();
  }

  private stopChain(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.runToken = undefined;
    this.nextRunAt = undefined;
  }

  // Store operations are serialized so a claim never reads a task half-way through a completion.
  private serialize<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    const result = this.writes.then(work, work);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private isChainAlive(): boolean {
    if (!this.runToken) return false;
    if (this.lease && this.lease.expiresAt > this.now()) return true;
    return this.nextRunAt !== undefined && this.now() < this.nextRunAt + STALL_GRACE_MS;
  }

  private startChain(): string {
    this.runToken = randomUUID();
    this.nextRunAt = this.now();
    this.lease = undefined;
    this.armStallCheck(0);
    return this.runToken;
  }

  private async claimableTasks(): Promise<HistoryImportTask[]> {
    return (await this.tasks.list())
      .filter((task) => !task.failedAt && !task.doneAt)
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.chatId.localeCompare(right.chatId));
  }

  // Queues chats for import. Returns a run token when Twenty must start a new job chain.
  queue(
    tasks: { chatId: string; conversationId: string; rangeDays: number }[],
  ): Promise<{ queued: number; runToken?: string }> {
    return this.serialize(async () => {
      const queuedAt = new Date(this.now()).toISOString();

      // A new run starts from an empty progress bar; an import queued during a run joins it.
      if (!this.isChainAlive()) {
        for (const task of await this.tasks.list()) {
          if (task.doneAt || task.failedAt) await this.tasks.delete(task.chatId);
        }
      }

      for (const { chatId, conversationId, rangeDays } of tasks) {
        const since = new Date(rangeDays ? this.now() - rangeDays * 86_400_000 : 0).toISOString();
        const messages = (await this.readMessages(chatId)) ?? [];
        await this.tasks.write(chatId, {
          taskId: randomUUID(),
          chatId,
          conversationId,
          since,
          imported: 0,
          processed: 0,
          total: messages.filter((message) => message.sentAt >= since).length,
          failures: 0,
          queuedAt,
        });
      }

      return { queued: tasks.length, ...(this.isChainAlive() ? {} : { runToken: this.startChain() }) };
    });
  }

  claim(runToken: string): Promise<ClaimResult> {
    return this.serialize(async () => {
      if (runToken !== this.runToken || (this.lease && this.lease.expiresAt > this.now())) {
        return { stale: true as const };
      }

      for (const task of await this.claimableTasks()) {
        const remaining = ((await this.readMessages(task.chatId)) ?? []).filter(
          (message) => message.sentAt >= task.since && isAfter(message, task.cursor),
        );
        if (remaining.length === 0) {
          await this.markDone(task, task.processed);
          continue;
        }

        const messages: MessageEvent[] = [];
        let mediaCount = 0;
        for (const message of remaining.slice(0, MAX_PAGE_MESSAGES)) {
          messages.push(message);
          if (message.media && ++mediaCount >= MAX_PAGE_MEDIA) break;
        }
        const isLastPage = messages.length === remaining.length;
        const inRange = isLastPage
          ? ((await this.readMessages(task.chatId)) ?? []).filter((message) => message.sentAt >= task.since)
          : [];
        const leaseId = randomUUID();
        this.lease = {
          id: leaseId,
          taskId: task.taskId,
          chatId: task.chatId,
          expiresAt: this.now() + LEASE_MS,
          messages,
          isLastPage,
        };
        this.armStallCheck(LEASE_MS);

        return {
          leaseId,
          chatId: task.chatId,
          conversationId: task.conversationId,
          messages,
          isLastPage,
          ...(isLastPage
            ? {
                summary: {
                  lastMessage: inRange.at(-1),
                  lastInboundAt: inRange.filter((message) => message.direction === 'inbound').at(-1)?.sentAt,
                },
              }
            : {}),
        };
      }

      this.stopChain();
      return { done: true as const };
    });
  }

  // Records the page as imported up to lastEventId (a job may stop early to stay within its time).
  complete(
    leaseId: string,
    lastEventId: string | undefined,
    imported: number,
    nextRunInMs: number,
  ): Promise<{ remaining: number }> {
    return this.serialize(async () => {
      const lease = this.takeLease(leaseId);
      const task = lease && (await this.tasks.read(lease.chatId));

      if (lease && task?.taskId === lease.taskId) {
        const index = lease.messages.findIndex((message) => message.eventId === lastEventId);
        const last = lease.messages[index];
        const progressed = { ...task, imported: task.imported + imported, processed: task.processed + index + 1 };
        if (last && lease.isLastPage && index === lease.messages.length - 1) {
          await this.markDone(progressed, progressed.processed);
        } else if (last) {
          await this.tasks.write(task.chatId, {
            ...progressed,
            cursor: { sentAt: last.sentAt, eventId: last.eventId },
            failures: 0,
          });
        }
      }

      return this.scheduleNext(nextRunInMs);
    });
  }

  // Gives the page back after a failure. A chat that keeps failing, or is abandoned, is set aside as failed.
  release(
    leaseId: string,
    failed: boolean,
    nextRunInMs: number,
    abandon = false,
  ): Promise<{ remaining: number; failures: number }> {
    return this.serialize(async () => {
      const lease = this.takeLease(leaseId);
      const task = lease && (await this.tasks.read(lease.chatId));
      let failures = 0;

      if (lease && task?.taskId === lease.taskId && failed) {
        failures = abandon ? MAX_FAILURES : task.failures + 1;
        await this.tasks.write(task.chatId, {
          ...task,
          failures,
          ...(failures >= MAX_FAILURES ? { failedAt: new Date(this.now()).toISOString() } : {}),
        });
      }

      return { ...(await this.scheduleNext(nextRunInMs)), failures };
    });
  }

  // Starts a new chain when work is queued but the previous chain was lost (job dropped, Twenty
  // unreachable, bridge restarted). Runs from the stall timer and when WhatsApp connects.
  recoverStalled(): Promise<{ runToken?: string }> {
    return this.serialize(async () => {
      if (this.isChainAlive()) {
        const expectedAt = this.lease?.expiresAt ?? this.nextRunAt ?? this.now();
        this.armStallCheck(expectedAt - this.now());
        return {};
      }
      if ((await this.claimableTasks()).length === 0) {
        this.stopChain();
        return {};
      }
      if (!this.canRun()) {
        this.armStallCheck(0);
        return {};
      }
      const runToken = this.startChain();
      this.onChainRestarted(runToken);
      return { runToken };
    });
  }

  progress(): Promise<HistoryImportProgress[]> {
    return this.serialize(async () => {
      const cutoff = new Date(this.now() - FINISHED_TASK_RETENTION_MS).toISOString();
      const progress: HistoryImportProgress[] = [];

      for (const task of await this.tasks.list()) {
        const finishedAt = task.failedAt ?? task.doneAt;
        if (finishedAt && finishedAt < cutoff) {
          await this.tasks.delete(task.chatId);
          continue;
        }
        progress.push({
          chatId: task.chatId,
          imported: task.imported,
          processed: Math.min(task.processed ?? 0, task.total),
          total: task.total,
          state: task.failedAt ? 'failed' : task.doneAt ? 'done' : 'queued',
        });
      }

      return progress;
    });
  }

  // Messages that arrived after the chat was queued can push processed past the initial total.
  private async markDone(task: HistoryImportTask, processed: number): Promise<void> {
    const total = Math.max(task.total, processed);
    await this.tasks.write(task.chatId, {
      ...task,
      processed: total,
      total,
      doneAt: new Date(this.now()).toISOString(),
    });
  }

  private takeLease(leaseId: string) {
    if (this.lease?.id !== leaseId) return undefined;
    const lease = this.lease;
    this.lease = undefined;
    return lease;
  }

  private async scheduleNext(nextRunInMs: number): Promise<{ remaining: number }> {
    const remaining = (await this.claimableTasks()).length;
    if (remaining === 0) {
      this.stopChain();
    } else {
      this.nextRunAt = this.now() + nextRunInMs;
      this.armStallCheck(nextRunInMs);
    }
    return { remaining };
  }
}
