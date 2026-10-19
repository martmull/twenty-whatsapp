// Twenty limits each app to 500 API requests per minute, shared by every workspace that installed
// it. This token bucket keeps the bridge's background jobs to a share of that, so the inbox and
// message sends keep room. Jobs ask for their estimated cost when they claim work and report what
// they actually used when they finish.
export const DEFAULT_BACKGROUND_REQUESTS_PER_MINUTE = 200;

// Live sync may borrow this share of a minute's budget, so new messages are not held back by a
// history import; background jobs leave this share untouched for it.
const LIVE_DEBT_SHARE = 0.25;
const LIVE_RESERVE_SHARE = 0.1;

export type BudgetPriority = 'live' | 'background';
export type BudgetDecision = { granted: true } | { granted: false; waitMs: number };

export class ApiBudget {
  private tokens: number;
  private updatedAt: number;
  private blockedUntil = 0;
  // When the last waiting background job was told to come back, so waiting jobs are spread out
  // instead of all retrying at once.
  private queuedUntil = 0;

  constructor(
    private readonly perMinute = DEFAULT_BACKGROUND_REQUESTS_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.updatedAt = now();
  }

  private get msPerToken(): number {
    return 60_000 / this.perMinute;
  }

  private refill(): number {
    const now = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + (now - this.updatedAt) / this.msPerToken);
    this.updatedAt = now;
    return now;
  }

  take(requestedCost: number, priority: BudgetPriority): BudgetDecision {
    const now = this.refill();
    const cost = Math.min(Math.max(0, requestedCost), this.perMinute);
    const floor = priority === 'live' ? -this.perMinute * LIVE_DEBT_SHARE : this.perMinute * LIVE_RESERVE_SHARE;

    if (now >= this.blockedUntil && this.tokens - cost >= floor) {
      this.tokens -= cost;
      return { granted: true };
    }

    const refilledAt = now + Math.max(0, floor + cost - this.tokens) * this.msPerToken;
    const readyAt = Math.max(this.blockedUntil, refilledAt);

    if (priority === 'live') {
      return { granted: false, waitMs: Math.ceil(readyAt - now) };
    }

    const servedAt = Math.max(this.queuedUntil, readyAt);
    this.queuedUntil = servedAt + cost * this.msPerToken;
    return { granted: false, waitMs: Math.ceil(servedAt - now) };
  }

  // How long until `take` would grant this cost, without taking it: lets a job schedule its next step
  // for when the budget allows it instead of being turned away and queued again.
  waitMs(requestedCost: number, priority: BudgetPriority): number {
    const now = this.refill();
    const cost = Math.min(Math.max(0, requestedCost), this.perMinute);
    const floor = priority === 'live' ? -this.perMinute * LIVE_DEBT_SHARE : this.perMinute * LIVE_RESERVE_SHARE;
    const refilledAt = now + Math.max(0, floor + cost - this.tokens) * this.msPerToken;
    const readyAt = Math.max(this.blockedUntil, refilledAt, priority === 'background' ? this.queuedUntil : 0);
    return Math.ceil(Math.max(0, readyAt - now));
  }

  // Corrects a claim's estimate with the requests the job made; the difference may leave a debt.
  adjust(extraRequests: number): void {
    this.refill();
    this.tokens -= extraRequests;
  }

  // Twenty rate limited a job: nothing runs until Twenty's own window has passed.
  penalize(retryAfterMs: number): void {
    const now = this.refill();
    this.blockedUntil = Math.max(this.blockedUntil, now + retryAfterMs);
    this.tokens = Math.min(this.tokens, 0);
  }
}
