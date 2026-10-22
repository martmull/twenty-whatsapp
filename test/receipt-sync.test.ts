import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { syncReceipts } from '../src/logic-functions/receipt-sync';
import { createFakeTwenty, mockBridge } from './fake-twenty';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
let restore: () => void = () => undefined;

afterEach(() => restore());

const eventId = (index: number) => index.toString(16).padStart(64, '0');
const message = (index: number, deliveryState: string, direction = 'OUTBOUND') => ({
  id: `message-${index}`,
  externalId: eventId(index),
  direction,
  deliveryState,
});

test('moves outgoing messages forward in one query and one update per state, and acknowledges them', async () => {
  const twenty = createFakeTwenty({
    whatsappMessages: [
      message(1, 'SENT'),
      message(2, 'SENT'),
      message(3, 'READ'),
      message(4, 'DELIVERED'),
      message(5, 'RECEIVED', 'INBOUND'),
    ],
  });
  const receipts = [
    { eventId: eventId(1), state: 'delivered' },
    { eventId: eventId(2), state: 'read' },
    // Late: never moves a read message back.
    { eventId: eventId(3), state: 'delivered' },
    // A failure after delivery is ignored.
    { eventId: eventId(4), state: 'failed' },
    // Incoming messages have no receipts.
    { eventId: eventId(5), state: 'read' },
    // Not in Twenty yet.
    { eventId: eventId(6), state: 'read' },
  ];
  const acks: Record<string, unknown>[] = [];
  const bridge = mockBridge({
    '/receipts/claim': () => ({ receipts, remaining: true }),
    '/receipts/ack': (body) => acks.push(body),
  });
  restore = bridge.restore;

  const result = await syncReceipts(silentLogger, { client: twenty.client });

  assert.deepEqual(result, { updated: 2, remaining: true });
  assert.deepEqual(twenty.requests, [
    'query whatsappMessages',
    'mutation updateWhatsappMessages',
    'mutation updateWhatsappMessages',
  ]);
  const stateOf = (index: number) =>
    (twenty.store.whatsappMessages as { id: string; deliveryState?: string }[]).find(
      (row) => row.id === `message-${index}`,
    )?.deliveryState;
  assert.deepEqual([1, 2, 3, 4, 5].map(stateOf), ['DELIVERED', 'READ', 'READ', 'DELIVERED', 'RECEIVED']);
  assert.deepEqual(acks, [{ written: receipts.slice(0, 4), missing: [eventId(5), eventId(6)] }]);
});

test('costs no Twenty request when no receipt is queued', async () => {
  const twenty = createFakeTwenty();
  const bridge = mockBridge({ '/receipts/claim': () => ({ receipts: [] }) });
  restore = bridge.restore;

  assert.deepEqual(await syncReceipts(silentLogger, { client: twenty.client }), { updated: 0, remaining: false });
  assert.deepEqual(twenty.requests, []);
});
