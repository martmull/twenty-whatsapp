import { randomUUID } from 'node:crypto';

import type { ApiBudget } from './api-budget.js';
import { EncryptedJsonStore } from './encrypted-json-store.js';

// Files of imported messages wait here, keyed by event ID so the same file is never queued twice,
// until a media job chain in Twenty uploads them. At most a few chains run, each one job at a time,
// so a burst of photos costs Twenty one job per few files instead of a burst of jobs: Twenty limits
// how many jobs an app may queue per minute.
export const MAX_MEDIA_CHAINS = 3;
export const MEDIA_ITEMS_PER_CLAIM = 5;
// Outlives the media job's 300-second timeout.
const LEASE_MS = 6 * 60_000;
// A chain that missed its scheduled run by this much is considered lost and is replaced.
const STALL_GRACE_MS = 60_000;
const STALL_CHECK_MS = 30_000;
const MAX_FAILURES = 3;
// A media job makes one request: the upsert attaching its files.
const CLAIM_COST = 1;
// Each step of a chain is one queued job; this spacing keeps the chains well under Twenty's limit
// on jobs per minute even when steps finish instantly. Real steps take longer, so it rarely waits.
const MIN_STEP_MS = 2_000;

export type MediaSource = 'live' | 'history';

export type MediaQueueItem = {
  messageId: string;
  eventId: string;
  fileName: string;
  source: MediaSource;
  queuedAt: string;
  failures: number;
};

export type MediaClaim =
  | { leaseId: string; seq: number; items: MediaQueueItem[] }
  | { waitMs: number; seq: number; nextJobKey: string }
  | { stale: true }
  | { done: true };

export type MediaChainStep = { remaining: number; seq?: number; nextJobKey?: string; nextRunInMs?: number };

type Chain = {
  token: string;
  seq: number;
  attempt: number;
  nextRunAt: number;
  lease?: { id: string; eventIds: string[]; expiresAt: number };
};

type MediaQueueOptions = {
  now?: () => number;
  budget?: Pick<ApiBudget, 'take' | 'adjust' | 'waitMs'>;
  // Called with the run tokens of chains Twenty must start because earlier ones were lost.
  onChainsRestarted?: (runTokens: string[]) => void;
  canRun?: () => boolean;
};

export class MediaQueue {
  private readonly items: EncryptedJsonStore<MediaQueueItem>;
  private readonly chains = new Map<string, Chain>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly budget: Pick<ApiBudget, 'take' | 'adjust' | 'waitMs'> | undefined;
  // The queued files, read from disk once and then kept in step with it.
  private cache: Map<string, MediaQueueItem> | undefined;
  private readonly onChainsRestarted: (runTokens: string[]) => void;
  private readonly canRun: () => boolean;
  private stallTimer: NodeJS.Timeout | undefined;

  constructor(
    directory: string,
    encryptionKey: Buffer,
    { now = Date.now, budget, onChainsRestarted = () => undefined, canRun = () => true }: MediaQueueOptions = {},
  ) {
    this.items = new EncryptedJsonStore(directory, encryptionKey);
    this.now = now;
    this.budget = budget;
    this.onChainsRestarted = onChainsRestarted;
    this.canRun = canRun;
  }

  private serialize<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    const result = this.writes.then(work, work);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async loaded(): Promise<Map<string, MediaQueueItem>> {
    this.cache ??= new Map((await this.items.list()).map((item) => [item.eventId, item]));
    return this.cache;
  }

  private async writeItem(item: MediaQueueItem): Promise<void> {
    await this.items.write(item.eventId, item);
    (await this.loaded()).set(item.eventId, item);
  }

  private async deleteItem(eventId: string): Promise<void> {
    if (!(await this.loaded()).has(eventId)) return;
    await this.items.delete(eventId);
    this.cache?.delete(eventId);
  }

  private nextJobKey(chain: Chain): string {
    return chain.attempt > 0 ? `${chain.seq}-${chain.attempt}` : `${chain.seq}`;
  }

  private isAlive(chain: Chain): boolean {
    if (chain.lease && chain.lease.expiresAt > this.now()) return true;
    return this.now() < chain.nextRunAt + STALL_GRACE_MS;
  }

  private leasedEventIds(exceptToken?: string): Set<string> {
    const leased = new Set<string>();
    for (const chain of this.chains.values()) {
      if (chain.token === exceptToken || !chain.lease || chain.lease.expiresAt <= this.now()) continue;
      for (const eventId of chain.lease.eventIds) leased.add(eventId);
    }
    return leased;
  }

  private async pending(exceptToken?: string): Promise<MediaQueueItem[]> {
    const leased = this.leasedEventIds(exceptToken);
    return [...(await this.loaded()).values()]
      .filter((item) => !leased.has(item.eventId))
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.eventId.localeCompare(right.eventId));
  }

  // Starts as many chains as the queue needs, up to the limit; returns the tokens Twenty must start.
  private async startChains(): Promise<string[]> {
    for (const [token, chain] of this.chains) {
      if (!this.isAlive(chain)) this.chains.delete(token);
    }
    const pending = (await this.pending()).length;
    const wanted = Math.min(MAX_MEDIA_CHAINS, Math.ceil(pending / MEDIA_ITEMS_PER_CLAIM)) - this.chains.size;
    const tokens: string[] = [];

    for (let index = 0; index < wanted; index += 1) {
      const token = randomUUID();
      this.chains.set(token, { token, seq: 0, attempt: 0, nextRunAt: this.now() });
      tokens.push(token);
    }
    if (this.chains.size > 0) this.armStallCheck();
    return tokens;
  }

  private armStallCheck(): void {
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => void this.recoverStalled(), STALL_CHECK_MS);
    this.stallTimer.unref();
  }

  queue(items: Omit<MediaQueueItem, 'queuedAt' | 'failures'>[]): Promise<{ queued: number; runTokens: string[] }> {
    return this.serialize(async () => {
      const queuedAt = new Date(this.now()).toISOString();
      let queued = 0;

      for (const item of items) {
        if ((await this.loaded()).has(item.eventId)) continue;
        await this.writeItem({ ...item, queuedAt, failures: 0 });
        queued += 1;
      }

      return { queued, runTokens: await this.startChains() };
    });
  }

  // A chain retried with the step it holds gets its files back, so an attach can be retried after a
  // rate limit without uploading again.
  claim(runToken: string, seq?: number): Promise<MediaClaim> {
    return this.serialize(async () => {
      const chain = this.chains.get(runToken);
      if (!chain) return { stale: true as const };
      if (seq !== undefined && seq !== chain.seq) return { stale: true as const };

      if (chain.lease && chain.lease.expiresAt > this.now()) {
        const cache = await this.loaded();
        const items = chain.lease.eventIds.flatMap((eventId) => cache.get(eventId) ?? []);
        return { leaseId: chain.lease.id, seq: chain.seq, items };
      }

      const items = (await this.pending(runToken)).slice(0, MEDIA_ITEMS_PER_CLAIM);
      if (items.length === 0) {
        this.chains.delete(runToken);
        return { done: true as const };
      }

      const decision = this.budget?.take(CLAIM_COST, 'background') ?? { granted: true as const };
      if (!decision.granted) {
        chain.attempt += 1;
        chain.lease = undefined;
        chain.nextRunAt = this.now() + decision.waitMs;
        return { waitMs: decision.waitMs, seq: chain.seq, nextJobKey: this.nextJobKey(chain) };
      }

      chain.lease = {
        id: randomUUID(),
        eventIds: items.map((item) => item.eventId),
        expiresAt: this.now() + LEASE_MS,
      };
      return { leaseId: chain.lease.id, seq: chain.seq, items };
    });
  }

  private chainOf(leaseId: string): Chain | undefined {
    return [...this.chains.values()].find((chain) => chain.lease?.id === leaseId);
  }

  private async step(chain: Chain | undefined, minDelayMs: number): Promise<MediaChainStep> {
    const remaining = (await this.pending()).length;
    if (!chain) return { remaining };
    if (remaining === 0) {
      this.chains.delete(chain.token);
      return { remaining };
    }
    const nextRunInMs = Math.max(minDelayMs, this.budget?.waitMs(CLAIM_COST, 'background') ?? 0);
    chain.nextRunAt = this.now() + nextRunInMs;
    return { remaining, seq: chain.seq, nextJobKey: this.nextJobKey(chain), nextRunInMs };
  }

  // Removes the files the job went through (attached, or no longer available on WhatsApp). The rest
  // of the lease goes back to the queue.
  // `elapsedMs` is how long the job ran, so the next step keeps its spacing from this one's start.
  complete(leaseId: string, processedEventIds: string[], requests?: number, elapsedMs = 0): Promise<MediaChainStep> {
    return this.serialize(async () => {
      const chain = this.chainOf(leaseId);
      if (chain && requests !== undefined) this.budget?.adjust(requests - CLAIM_COST);
      for (const eventId of processedEventIds) await this.deleteItem(eventId);
      if (chain) {
        chain.lease = undefined;
        chain.seq += 1;
        chain.attempt = 0;
      }
      return this.step(chain, Math.max(0, MIN_STEP_MS - elapsedMs));
    });
  }

  // Gives the files back after a failure; a file that keeps failing is dropped.
  release(leaseId: string, failed: boolean, nextRunInMs: number, requests?: number): Promise<MediaChainStep> {
    return this.serialize(async () => {
      const chain = this.chainOf(leaseId);
      if (chain && requests !== undefined) this.budget?.adjust(requests - CLAIM_COST);
      for (const eventId of failed ? (chain?.lease?.eventIds ?? []) : []) {
        const item = (await this.loaded()).get(eventId);
        if (!item) continue;
        if (item.failures + 1 >= MAX_FAILURES) await this.deleteItem(eventId);
        else await this.writeItem({ ...item, failures: item.failures + 1 });
      }
      if (chain) {
        chain.lease = undefined;
        chain.attempt += 1;
      }
      return this.step(chain, nextRunInMs);
    });
  }

  // Drops the queued files of one source, such as a cancelled history import.
  cancel(source: MediaSource): Promise<{ cancelled: number }> {
    return this.serialize(async () => {
      let cancelled = 0;
      for (const item of [...(await this.loaded()).values()]) {
        if (item.source !== source) continue;
        await this.deleteItem(item.eventId);
        cancelled += 1;
      }
      return { cancelled };
    });
  }

  // Replaces lost chains (job dropped, Twenty unreachable, bridge restarted) while files wait.
  recoverStalled(): Promise<{ runTokens: string[] }> {
    return this.serialize(async () => {
      const lost = [...this.chains.values()].some((chain) => !this.isAlive(chain));
      if (!lost && this.chains.size > 0) return { runTokens: [] };
      if (!this.canRun()) return { runTokens: [] };

      const runTokens = await this.startChains();
      if (this.chains.size === 0 && this.stallTimer) {
        clearInterval(this.stallTimer);
        this.stallTimer = undefined;
      }
      if (runTokens.length > 0) this.onChainsRestarted(runTokens);
      return { runTokens };
    });
  }
}
