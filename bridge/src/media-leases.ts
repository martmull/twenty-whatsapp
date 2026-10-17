import { randomUUID } from 'node:crypto';

import type { ApiBudget } from './api-budget.js';

// Media import jobs each hold a lease while they download from the bridge and upload to Twenty, so
// a burst of photos never runs more downloads at once than the bridge and Twenty's worker can take.
export const MAX_MEDIA_LEASES = 3;
// Outlives the media job's 300-second timeout, so a job that died without releasing frees its slot.
const LEASE_MS = 6 * 60_000;
// About how long a job of five files holds its lease. Waiting jobs are given successive slots this
// far apart (per lease), instead of all coming back at once.
const TYPICAL_JOB_MS = 15_000;
// A media job makes one request: the upsert attaching its files.
const MEDIA_JOB_COST = 1;

export class MediaLeases {
  private readonly leases = new Map<string, { expiresAt: number; cost: number }>();
  private nextSlotAt = 0;

  constructor(
    private readonly maxLeases = MAX_MEDIA_LEASES,
    private readonly now: () => number = Date.now,
    private readonly budget?: Pick<ApiBudget, 'take' | 'adjust'>,
  ) {}

  claim(): { leaseId: string } | { waitMs: number } {
    const now = this.now();
    for (const [leaseId, { expiresAt }] of this.leases) {
      if (expiresAt <= now) this.leases.delete(leaseId);
    }
    if (this.leases.size >= this.maxLeases) {
      this.nextSlotAt = Math.max(this.nextSlotAt, now) + TYPICAL_JOB_MS / this.maxLeases;
      return { waitMs: Math.ceil(this.nextSlotAt - now) };
    }
    const decision = this.budget?.take(MEDIA_JOB_COST, 'background') ?? { granted: true as const };
    if (!decision.granted) {
      return { waitMs: decision.waitMs };
    }
    const leaseId = randomUUID();
    this.leases.set(leaseId, { expiresAt: now + LEASE_MS, cost: MEDIA_JOB_COST });
    return { leaseId };
  }

  release(leaseId: string, requests?: number): { released: boolean } {
    const lease = this.leases.get(leaseId);
    if (lease && requests !== undefined) this.budget?.adjust(requests - lease.cost);
    return { released: this.leases.delete(leaseId) };
  }
}
