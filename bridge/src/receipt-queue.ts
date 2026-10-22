import { EncryptedJsonStore } from './encrypted-json-store.js';
import type { Storage } from './storage.js';

export type ReceiptState = 'failed' | 'delivered' | 'read';
export type Receipt = { eventId: string; state: ReceiptState };
type StoredReceipt = Receipt & { receivedAt: number };

// Twenty updates at most this many messages per sync job.
export const MAX_RECEIPTS_PER_CLAIM = 200;
// Expired receipts are dropped while scanning up to this many.
const MAX_RECEIPTS_SCANNED = 1_000;
// A receipt for a message Twenty does not have yet (still queued as an event) waits this long.
export const MISSING_MESSAGE_GRACE_MS = 10 * 60_000;
// A receipt nobody claims (the app is older than the bridge) is dropped after this.
export const RECEIPT_TTL_MS = 24 * 60 * 60_000;

// A message only moves forward: a late "delivered" never replaces "read".
const RANK: Record<ReceiptState, number> = { failed: 0, delivered: 1, read: 2 };

const EVENT_ID = /^[a-f\d]{64}$/;

// Baileys' WebMessageInfo.Status: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED.
// PENDING and SERVER_ACK add nothing to "sent", which Twenty already records.
export const receiptStateOf = (status: number | null | undefined): ReceiptState | undefined =>
  status === 0 ? 'failed' : status === 3 ? 'delivered' : status === 4 || status === 5 ? 'read' : undefined;

// The latest delivery state of outgoing messages, until Twenty has written it. Keyed by the message's
// event ID, which is also its externalId in Twenty.
export class ReceiptQueue {
  private readonly store: EncryptedJsonStore<StoredReceipt>;

  constructor(
    storage: Storage,
    encryptionKey: Buffer,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.store = new EncryptedJsonStore(storage, 'receipts', encryptionKey);
  }

  // True when a receipt moved a message forward, so Twenty has something to do.
  async record(receipts: Receipt[]): Promise<boolean> {
    const latest = new Map<string, ReceiptState>();
    for (const { eventId, state } of receipts) {
      const current = latest.get(eventId);
      if (EVENT_ID.test(eventId) && (current === undefined || RANK[state] > RANK[current])) latest.set(eventId, state);
    }

    const writes: [string, StoredReceipt][] = [];
    for (const [eventId, state] of latest) {
      const queued = await this.store.read(eventId);
      if (queued && RANK[queued.state] >= RANK[state]) continue;
      writes.push([eventId, { eventId, state, receivedAt: this.now() }]);
    }

    if (writes.length > 0) await this.store.writeMany(writes);
    return writes.length > 0;
  }

  async claim(): Promise<{ receipts: Receipt[]; remaining: boolean }> {
    const scanned = await this.store.list(MAX_RECEIPTS_SCANNED);
    const expired = scanned.filter((receipt) => this.now() - receipt.receivedAt > RECEIPT_TTL_MS);
    if (expired.length > 0) await this.store.writeMany(expired.map((receipt) => [receipt.eventId, undefined]));

    const live = scanned.filter((receipt) => !expired.includes(receipt));
    return {
      receipts: live.slice(0, MAX_RECEIPTS_PER_CLAIM).map(({ eventId, state }) => ({ eventId, state })),
      remaining: live.length > MAX_RECEIPTS_PER_CLAIM,
    };
  }

  // `written`: Twenty has the message in that state. A receipt that moved it further since the claim
  // stays queued. `missing`: Twenty has no such outgoing message yet; it is dropped once the grace
  // period is over, so it cannot hold the queue.
  async ack(written: Receipt[], missing: string[]): Promise<{ acknowledged: number }> {
    const remove: string[] = [];
    for (const { eventId, state } of written) {
      const queued = await this.store.read(eventId);
      if (queued && RANK[queued.state] <= RANK[state]) remove.push(eventId);
    }
    for (const eventId of missing) {
      const queued = await this.store.read(eventId);
      if (queued && this.now() - queued.receivedAt > MISSING_MESSAGE_GRACE_MS) remove.push(eventId);
    }

    if (remove.length > 0) await this.store.writeMany(remove.map((eventId) => [eventId, undefined]));
    return { acknowledged: remove.length };
  }
}
