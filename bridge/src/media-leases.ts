import { randomUUID } from 'node:crypto';

// Media import jobs each hold a lease while they download from the bridge and upload to Twenty, so
// a burst of photos never runs more downloads at once than the bridge and Twenty's worker can take.
export const MAX_MEDIA_LEASES = 3;
// Outlives the media job's 300-second timeout, so a job that died without releasing frees its slot.
const LEASE_MS = 6 * 60_000;
const BUSY_WAIT_MS = 10_000;

export class MediaLeases {
  private readonly leases = new Map<string, number>();

  constructor(
    private readonly maxLeases = MAX_MEDIA_LEASES,
    private readonly now: () => number = Date.now,
  ) {}

  claim(): { leaseId: string } | { waitMs: number } {
    for (const [leaseId, expiresAt] of this.leases) {
      if (expiresAt <= this.now()) this.leases.delete(leaseId);
    }
    if (this.leases.size >= this.maxLeases) {
      return { waitMs: BUSY_WAIT_MS };
    }
    const leaseId = randomUUID();
    this.leases.set(leaseId, this.now() + LEASE_MS);
    return { leaseId };
  }

  release(leaseId: string): { released: boolean } {
    return { released: this.leases.delete(leaseId) };
  }
}
