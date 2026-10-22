import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  MAX_RECEIPTS_PER_CLAIM,
  MISSING_MESSAGE_GRACE_MS,
  RECEIPT_TTL_MS,
  ReceiptQueue,
  receiptStateOf,
} from '../src/receipt-queue.js';

import { MemoryStorage } from './memory-storage.js';

const eventId = (index: number) => index.toString(16).padStart(64, '0');

const withQueue = () => {
  const clock = { now: Date.UTC(2026, 9, 22) };
  return { clock, queue: new ReceiptQueue(new MemoryStorage(), randomBytes(32), () => clock.now) };
};

test('maps Baileys statuses to receipts, ignoring pending and server acks', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, null, undefined].map(receiptStateOf), [
    'failed',
    undefined,
    undefined,
    'delivered',
    'read',
    'read',
    undefined,
    undefined,
  ]);
});

test('keeps the furthest state of each message, and reports when nothing moved', async () => {
  const { queue } = withQueue();

  assert.equal(
    await queue.record([
      { eventId: eventId(1), state: 'read' },
      { eventId: eventId(1), state: 'delivered' },
      { eventId: eventId(2), state: 'delivered' },
    ]),
    true,
  );
  assert.equal(await queue.record([{ eventId: eventId(1), state: 'delivered' }]), false);
  assert.equal(await queue.record([{ eventId: 'not-an-event-id', state: 'read' }]), false);

  const { receipts } = await queue.claim();
  assert.deepEqual(
    receipts.sort((left, right) => left.eventId.localeCompare(right.eventId)),
    [
      { eventId: eventId(1), state: 'read' },
      { eventId: eventId(2), state: 'delivered' },
    ],
  );
});

test('an acknowledgement does not drop a receipt that moved further since the claim', async () => {
  const { queue } = withQueue();
  await queue.record([{ eventId: eventId(1), state: 'delivered' }]);
  const { receipts } = await queue.claim();
  await queue.record([{ eventId: eventId(1), state: 'read' }]);

  assert.deepEqual(await queue.ack(receipts, []), { acknowledged: 0 });
  assert.deepEqual((await queue.claim()).receipts, [{ eventId: eventId(1), state: 'read' }]);

  assert.deepEqual(await queue.ack([{ eventId: eventId(1), state: 'read' }], []), { acknowledged: 1 });
  assert.deepEqual((await queue.claim()).receipts, []);
});

test('waits for a message Twenty does not have yet, then drops it after the grace period', async () => {
  const { clock, queue } = withQueue();
  await queue.record([{ eventId: eventId(1), state: 'delivered' }]);

  assert.deepEqual(await queue.ack([], [eventId(1)]), { acknowledged: 0 });
  clock.now += MISSING_MESSAGE_GRACE_MS + 1;
  assert.deepEqual(await queue.ack([], [eventId(1)]), { acknowledged: 1 });
  assert.deepEqual((await queue.claim()).receipts, []);
});

test('claims a bounded batch, says when more remain, and drops receipts nobody claimed in time', async () => {
  const { clock, queue } = withQueue();
  await queue.record(
    Array.from({ length: MAX_RECEIPTS_PER_CLAIM + 5 }, (_, index) => ({
      eventId: eventId(index + 1),
      state: 'delivered' as const,
    })),
  );

  const first = await queue.claim();
  assert.equal(first.receipts.length, MAX_RECEIPTS_PER_CLAIM);
  assert.equal(first.remaining, true);

  clock.now += RECEIPT_TTL_MS + 1;
  assert.deepEqual(await queue.claim(), { receipts: [], remaining: false });
});
