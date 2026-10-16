import { randomUUID } from 'node:crypto';

import { EncryptedJsonStore } from './encrypted-json-store.js';
import type { MessageEvent } from './message-event.js';

// Twenty imports selected history in a chain of background jobs, one page per job. This queue holds
// what is left to import and makes sure only one chain runs: each job must present the current run
// token, so a duplicate chain (a job retried, or resumed by the cron) stops at its next claim.

export const MAX_PAGE_MESSAGES = 100;
export const MAX_PAGE_MEDIA = 5;
const LEASE_MS = 6 * 60_000;
// A chain that missed its scheduled run by this much is considered lost and can be resumed.
const STALL_GRACE_MS = 3 * 60_000;
const MAX_FAILURES = 5;
const FAILED_TASK_RETENTION_MS = 24 * 60 * 60_000;

type Cursor = { sentAt: string; eventId: string };

export type HistoryImportTask = {
  taskId: string;
  chatId: string;
  conversationId: string;
  since: string;
  cursor?: Cursor;
  imported: number;
  total: number;
  failures: number;
  queuedAt: string;
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
  total: number;
  state: 'queued' | 'failed';
};

type ClaimResult = HistoryImportPage | { stale: true } | { done: true };

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

  constructor(
    directory: string,
    encryptionKey: Buffer,
    // Messages of a chat sorted by sentAt then eventId, as kept in the history cache.
    private readonly readMessages: (chatId: string) => Promise<MessageEvent[] | undefined>,
    private readonly now: () => number = Date.now,
  ) {
    this.tasks = new EncryptedJsonStore(directory, encryptionKey);
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
    return this.runToken;
  }

  private async claimableTasks(): Promise<HistoryImportTask[]> {
    return (await this.tasks.list())
      .filter((task) => !task.failedAt)
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.chatId.localeCompare(right.chatId));
  }

  // Queues chats for import. Returns a run token when Twenty must start a new job chain.
  queue(
    tasks: { chatId: string; conversationId: string; rangeDays: 0 | 30 | 90 }[],
  ): Promise<{ queued: number; runToken?: string }> {
    return this.serialize(async () => {
      const queuedAt = new Date(this.now()).toISOString();

      for (const { chatId, conversationId, rangeDays } of tasks) {
        const since = new Date(rangeDays ? this.now() - rangeDays * 86_400_000 : 0).toISOString();
        const messages = (await this.readMessages(chatId)) ?? [];
        await this.tasks.write(chatId, {
          taskId: randomUUID(),
          chatId,
          conversationId,
          since,
          imported: 0,
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
          await this.tasks.delete(task.chatId);
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

      this.runToken = undefined;
      this.nextRunAt = undefined;
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
        if (last && lease.isLastPage && index === lease.messages.length - 1) {
          await this.tasks.delete(task.chatId);
        } else if (last) {
          await this.tasks.write(task.chatId, {
            ...task,
            cursor: { sentAt: last.sentAt, eventId: last.eventId },
            imported: task.imported + imported,
            failures: 0,
          });
        }
      }

      return this.scheduleNext(nextRunInMs);
    });
  }

  // Gives the page back after a failure. A chat that keeps failing is set aside as failed.
  release(leaseId: string, failed: boolean, nextRunInMs: number): Promise<{ remaining: number; failures: number }> {
    return this.serialize(async () => {
      const lease = this.takeLease(leaseId);
      const task = lease && (await this.tasks.read(lease.chatId));
      let failures = 0;

      if (lease && task?.taskId === lease.taskId && failed) {
        failures = task.failures + 1;
        await this.tasks.write(task.chatId, {
          ...task,
          failures,
          ...(failures >= MAX_FAILURES ? { failedAt: new Date(this.now()).toISOString() } : {}),
        });
      }

      return { ...(await this.scheduleNext(nextRunInMs)), failures };
    });
  }

  // Starts a new chain when work is queued but the previous chain was lost (job dropped, bridge restart).
  resume(): Promise<{ runToken?: string }> {
    return this.serialize(async () => {
      if (this.isChainAlive() || (await this.claimableTasks()).length === 0) return {};
      return { runToken: this.startChain() };
    });
  }

  progress(): Promise<HistoryImportProgress[]> {
    return this.serialize(async () => {
      const cutoff = new Date(this.now() - FAILED_TASK_RETENTION_MS).toISOString();
      const progress: HistoryImportProgress[] = [];

      for (const task of await this.tasks.list()) {
        if (task.failedAt && task.failedAt < cutoff) {
          await this.tasks.delete(task.chatId);
          continue;
        }
        progress.push({
          chatId: task.chatId,
          imported: task.imported,
          total: task.total,
          state: task.failedAt ? 'failed' : 'queued',
        });
      }

      return progress;
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
      this.runToken = undefined;
      this.nextRunAt = undefined;
    } else {
      this.nextRunAt = this.now() + nextRunInMs;
    }
    return { remaining };
  }
}
