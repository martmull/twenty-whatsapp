import { randomUUID } from 'node:crypto';

import type { ApiBudget } from './api-budget.js';
import { EncryptedJsonStore } from './encrypted-json-store.js';
import type { MessageEvent } from './message-event.js';

// Twenty imports selected history in a chain of background jobs, one page per job. This queue holds
// what is left to import and makes sure only one chain runs: each job must present the current run
// token and page number, so a duplicate chain (a job retried, or a lost chain replaced) stops at its
// next claim. A job retried with the page it already holds gets the same page back: Twenty's writes
// are upserts, so importing it twice is harmless.

// One messages upsert per page: Twenty takes up to 200 records per request.
export const MAX_PAGE_MESSAGES = 200;
// Keeps a page of long texts well under Twenty's request size limits.
const MAX_PAGE_BYTES = 450_000;
// Summaries of finished chats are written together, once this many are waiting or nothing else is.
export const SUMMARY_FLUSH_SIZE = 20;
// Stays under the 200 conversations Twenty returns for the summary query.
const MAX_SUMMARIES_PER_PAGE = 100;
const LEASE_MS = 6 * 60_000;
// A chain that missed its scheduled run by this much is considered lost and can be resumed.
const STALL_GRACE_MS = 60_000;
const MAX_FAILURES = 5;
// Finished and failed chats stay listed so progress covers the whole run, then are cleared by the
// next run or after this long.
const FINISHED_TASK_RETENTION_MS = 24 * 60 * 60_000;

type Cursor = { sentAt: string; eventId: string };

export type ConversationSummary = { lastMessage?: { sentAt: string; text: string }; lastInboundAt?: string };

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
  // Set once the chat is done, until Twenty has written the conversation summary.
  summary?: ConversationSummary;
  summaryPending?: boolean;
};

export type HistoryImportPageChat = {
  chatId: string;
  conversationId: string;
  messages: MessageEvent[];
  isLastPage: boolean;
};

export type HistoryImportSummary = ConversationSummary & { chatId: string; conversationId: string };

export type HistoryImportPage = {
  leaseId: string;
  pageSeq: number;
  chats: HistoryImportPageChat[];
  // Summaries of chats finished on earlier pages, to write in one go.
  summaries: HistoryImportSummary[];
};

export type HistoryImportProgress = {
  chatId: string;
  imported: number;
  processed: number;
  total: number;
  state: 'queued' | 'done' | 'failed';
};

// What Twenty needs to queue the next job: the page it should claim and the key naming the job.
export type ChainStep = { remaining: number; pageSeq: number; nextJobKey: string; nextRunInMs: number };

// The API budget is spent: the job queues itself for the same page after waitMs.
type ClaimWait = { waitMs: number; pageSeq: number; nextJobKey: string };

type ClaimResult = HistoryImportPage | ClaimWait | { stale: true } | { done: true };

// A page costs one messages upsert, and a summary flush one query and one upsert.
const PAGE_COST = 1;
// Each page is one queued job; this spacing keeps the chain well under Twenty's limit on jobs per
// minute even when pages finish instantly.
const MIN_PAGE_MS = 1_000;
const SUMMARY_FLUSH_COST = 2;

type Lease = {
  id: string;
  pageSeq: number;
  cost: number;
  expiresAt: number;
  chats: (HistoryImportPageChat & { taskId: string })[];
  summaryTaskIds: { chatId: string; taskId: string }[];
  page: HistoryImportPage;
};

type HistoryImportQueueOptions = {
  now?: () => number;
  // Called with a new run token when a lost chain is replaced; Twenty must start a job with it.
  onChainRestarted?: (runToken: string) => void;
  // A chain is only restarted while WhatsApp is connected, since its jobs could not claim pages.
  canRun?: () => boolean;
  budget?: Pick<ApiBudget, 'take' | 'adjust' | 'waitMs'>;
};

const isAfter = (message: MessageEvent, cursor?: Cursor) =>
  !cursor ||
  message.sentAt > cursor.sentAt ||
  (message.sentAt === cursor.sentAt && message.eventId.localeCompare(cursor.eventId) > 0);

export class HistoryImportQueue {
  private readonly tasks: EncryptedJsonStore<HistoryImportTask>;
  private runToken: string | undefined;
  private nextRunAt: number | undefined;
  private pageSeq = 0;
  // Counts the retries of the current page, so each retry job gets its own job ID.
  private pageAttempt = 0;
  private lease: Lease | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private stallTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly onChainRestarted: (runToken: string) => void;
  private readonly canRun: () => boolean;
  private readonly budget: Pick<ApiBudget, 'take' | 'adjust' | 'waitMs'> | undefined;

  constructor(
    directory: string,
    encryptionKey: Buffer,
    // Messages of a chat sorted by sentAt then eventId, as kept in the history cache.
    private readonly readMessages: (chatId: string) => Promise<MessageEvent[] | undefined>,
    { now = Date.now, onChainRestarted = () => undefined, canRun = () => true, budget }: HistoryImportQueueOptions = {},
  ) {
    this.tasks = new EncryptedJsonStore(directory, encryptionKey);
    this.budget = budget;
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
    this.pageSeq = 0;
    this.pageAttempt = 0;
    this.lease = undefined;
    this.armStallCheck(0);
    return this.runToken;
  }

  private nextJobKey(): string {
    return this.pageAttempt > 0 ? `${this.pageSeq}-${this.pageAttempt}` : `${this.pageSeq}`;
  }

  private async claimableTasks(): Promise<HistoryImportTask[]> {
    return (await this.tasks.list())
      .filter((task) => !task.failedAt && !task.doneAt)
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.chatId.localeCompare(right.chatId));
  }

  private async pendingSummaries(): Promise<HistoryImportTask[]> {
    return (await this.tasks.list())
      .filter((task) => task.doneAt && task.summaryPending)
      .sort((left, right) => left.chatId.localeCompare(right.chatId));
  }

  // Work left for the chain: chats to import, and summaries to write as its last step.
  private async remainingWork(): Promise<number> {
    return (await this.claimableTasks()).length + ((await this.pendingSummaries()).length > 0 ? 1 : 0);
  }

  // Queues chats for import. Returns a run token when Twenty must start a new job chain.
  queue(
    tasks: { chatId: string; conversationId: string; rangeDays: number }[],
  ): Promise<{ queued: number; runToken?: string }> {
    return this.serialize(async () => {
      const queuedAt = new Date(this.now()).toISOString();

      // A new run starts from an empty progress bar; an import queued during a run joins it.
      // Chats whose summary is still to be written stay until the new chain writes it.
      if (!this.isChainAlive()) {
        for (const task of await this.tasks.list()) {
          if ((task.doneAt && !task.summaryPending) || task.failedAt) await this.tasks.delete(task.chatId);
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

  // Packs the next page from the queued chats, oldest queued first. A chat that failed before is
  // served alone, so it cannot keep failing the chats it would share a page with.
  private async buildPage(): Promise<{ chats: Lease['chats']; summaryTasks: HistoryImportTask[] }> {
    const chats: Lease['chats'] = [];
    let count = 0;
    let bytes = 0;

    for (const task of await this.claimableTasks()) {
      if (task.failures > 0 && chats.length > 0) break;

      const remaining = ((await this.readMessages(task.chatId)) ?? []).filter(
        (message) => message.sentAt >= task.since && isAfter(message, task.cursor),
      );
      if (remaining.length === 0) {
        await this.markDone(task, task.processed);
        continue;
      }

      const messages: MessageEvent[] = [];
      for (const message of remaining) {
        const size = Buffer.byteLength(JSON.stringify(message));
        if (count >= MAX_PAGE_MESSAGES || (count > 0 && bytes + size > MAX_PAGE_BYTES)) break;
        messages.push(message);
        count += 1;
        bytes += size;
      }
      if (messages.length === 0) break;

      chats.push({
        taskId: task.taskId,
        chatId: task.chatId,
        conversationId: task.conversationId,
        messages,
        isLastPage: messages.length === remaining.length,
      });
      if (task.failures > 0 || count >= MAX_PAGE_MESSAGES || messages.length < remaining.length) break;
    }

    const pending = await this.pendingSummaries();
    const flush = chats.length === 0 || pending.length >= SUMMARY_FLUSH_SIZE;
    return { chats, summaryTasks: flush ? pending.slice(0, MAX_SUMMARIES_PER_PAGE) : [] };
  }

  claim(runToken: string, pageSeq?: number): Promise<ClaimResult> {
    return this.serialize(async () => {
      if (runToken !== this.runToken) {
        return { stale: true as const };
      }

      const leased = this.lease && this.lease.expiresAt > this.now() ? this.lease : undefined;
      if (leased) {
        // The job holding this page was retried: hand the same page back.
        return pageSeq === leased.pageSeq ? leased.page : { stale: true as const };
      }

      // A bridge-side check only for apps that send the page number.
      if (pageSeq !== undefined && pageSeq !== this.pageSeq) {
        return { stale: true as const };
      }

      const { chats, summaryTasks } = await this.buildPage();

      if (chats.length === 0 && summaryTasks.length === 0) {
        this.stopChain();
        return { done: true as const };
      }

      const cost = (chats.length > 0 ? PAGE_COST : 0) + (summaryTasks.length > 0 ? SUMMARY_FLUSH_COST : 0);
      const decision = this.budget?.take(cost, 'background') ?? { granted: true as const };
      if (!decision.granted) {
        this.pageAttempt += 1;
        this.nextRunAt = this.now() + decision.waitMs;
        this.armStallCheck(decision.waitMs);
        return { waitMs: decision.waitMs, pageSeq: this.pageSeq, nextJobKey: this.nextJobKey() };
      }

      const leaseId = randomUUID();
      const page: HistoryImportPage = {
        leaseId,
        pageSeq: this.pageSeq,
        chats: chats.map(({ chatId, conversationId, messages, isLastPage }) => ({
          chatId,
          conversationId,
          messages,
          isLastPage,
        })),
        summaries: summaryTasks.map((task) => ({
          chatId: task.chatId,
          conversationId: task.conversationId,
          ...task.summary,
        })),
      };
      this.lease = {
        id: leaseId,
        pageSeq: this.pageSeq,
        cost,
        expiresAt: this.now() + LEASE_MS,
        chats,
        summaryTaskIds: summaryTasks.map(({ chatId, taskId }) => ({ chatId, taskId })),
        page,
      };
      this.armStallCheck(LEASE_MS);

      return page;
    });
  }

  // Records the page as imported. `importedByChat` counts the messages Twenty created, per chat.
  // `requests` is what the job actually spent, correcting the claim's estimate; `elapsedMs` is how
  // long it ran, so the next page keeps its spacing from this one's start.
  complete(
    leaseId: string,
    importedByChat: Record<string, number>,
    nextRunInMs: number,
    requests?: number,
    elapsedMs = 0,
  ): Promise<ChainStep> {
    return this.serialize(async () => {
      const lease = this.takeLease(leaseId);

      if (lease && requests !== undefined) this.budget?.adjust(requests - lease.cost);
      if (lease) {
        for (const chat of lease.chats) {
          const task = await this.tasks.read(chat.chatId);
          if (task?.taskId !== chat.taskId) continue;

          const last = chat.messages.at(-1)!;
          const progressed = {
            ...task,
            imported: task.imported + (importedByChat[chat.chatId] ?? 0),
            processed: task.processed + chat.messages.length,
            cursor: { sentAt: last.sentAt, eventId: last.eventId },
            failures: 0,
          };
          if (chat.isLastPage) {
            await this.markDone(progressed, progressed.processed);
          } else {
            await this.tasks.write(task.chatId, progressed);
          }
        }

        for (const { chatId, taskId } of lease.summaryTaskIds) {
          const task = await this.tasks.read(chatId);
          if (task?.taskId === taskId) await this.tasks.write(chatId, { ...task, summaryPending: false });
        }

        this.pageSeq += 1;
        this.pageAttempt = 0;
      }

      return this.scheduleNext(
        Math.max(nextRunInMs, MIN_PAGE_MS - elapsedMs, this.budget?.waitMs(PAGE_COST, 'background') ?? 0),
      );
    });
  }

  // Gives the page back after a failure. A chat that keeps failing is set aside as failed, and an
  // abandoned one (its conversation was deleted) at once, without blaming the others.
  release(
    leaseId: string,
    failed: boolean,
    nextRunInMs: number,
    requests?: number,
    abandonedChatIds: string[] = [],
  ): Promise<ChainStep & { failures: number }> {
    return this.serialize(async () => {
      const lease = this.takeLease(leaseId);
      let failures = 0;

      if (lease && requests !== undefined) this.budget?.adjust(requests - lease.cost);
      if (lease) {
        this.pageAttempt += 1;
        const abandoned = new Set(abandonedChatIds);
        const blamed = abandoned.size > 0 ? lease.chats.filter((chat) => abandoned.has(chat.chatId)) : lease.chats;
        for (const chat of failed ? blamed : []) {
          const task = await this.tasks.read(chat.chatId);
          if (task?.taskId !== chat.taskId) continue;
          const taskFailures = abandoned.has(chat.chatId) ? MAX_FAILURES : task.failures + 1;
          failures = Math.max(failures, taskFailures);
          await this.tasks.write(task.chatId, {
            ...task,
            failures: taskFailures,
            ...(taskFailures >= MAX_FAILURES ? { failedAt: new Date(this.now()).toISOString() } : {}),
          });
        }
      }

      return { ...(await this.scheduleNext(nextRunInMs)), failures };
    });
  }

  // Drops the chats still queued and ends the chain, so its jobs stop at their next claim. Finished
  // chats stay, with any summary still to be written.
  cancel(): Promise<{ cancelled: number; runToken?: string }> {
    return this.serialize(async () => {
      const runToken = this.runToken;
      let cancelled = 0;
      for (const task of await this.claimableTasks()) {
        await this.tasks.delete(task.chatId);
        cancelled += 1;
      }
      this.lease = undefined;
      this.stopChain();
      return { cancelled, ...(runToken ? { runToken } : {}) };
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
      if ((await this.remainingWork()) === 0) {
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
        if (finishedAt && finishedAt < cutoff && !task.summaryPending) {
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
  // The summary covers the selected range, as the conversation should show its latest message.
  private async markDone(task: HistoryImportTask, processed: number): Promise<void> {
    const total = Math.max(task.total, processed);
    const inRange = ((await this.readMessages(task.chatId)) ?? []).filter((message) => message.sentAt >= task.since);
    const lastMessage = inRange.at(-1);
    const lastInboundAt = inRange.filter((message) => message.direction === 'inbound').at(-1)?.sentAt;

    await this.tasks.write(task.chatId, {
      ...task,
      processed: total,
      total,
      doneAt: new Date(this.now()).toISOString(),
      summary: {
        ...(lastMessage ? { lastMessage: { sentAt: lastMessage.sentAt, text: lastMessage.text } } : {}),
        ...(lastInboundAt ? { lastInboundAt } : {}),
      },
      summaryPending: Boolean(lastMessage || lastInboundAt),
    });
  }

  private takeLease(leaseId: string) {
    if (this.lease?.id !== leaseId) return undefined;
    const lease = this.lease;
    this.lease = undefined;
    return lease;
  }

  private async scheduleNext(nextRunInMs: number): Promise<ChainStep> {
    const remaining = await this.remainingWork();
    if (remaining === 0) {
      this.stopChain();
    } else {
      this.nextRunAt = this.now() + nextRunInMs;
      this.armStallCheck(nextRunInMs);
    }
    return { remaining, pageSeq: this.pageSeq, nextJobKey: this.nextJobKey(), nextRunInMs: Math.max(0, nextRunInMs) };
  }
}
