import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runMessageSync } from '../src/logic-functions/whatsapp-message-sync';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const result = (acknowledged: number, remaining: boolean, extra: { jobKey?: string; retryInMs?: number } = {}) => ({
  imported: acknowledged,
  ignored: 0,
  acknowledged,
  remaining,
  ...extra,
});

const run = async (outcome: ReturnType<typeof result> | Error, attempt = 0) => {
  const queued: { payload: object; delayMs: number; jobId?: string }[] = [];
  await runMessageSync({ events: true, attempt }, silentLogger, {
    sync: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    syncDeliveryReceipts: async () => ({ updated: 0, remaining: false }),
    enqueue: async (payload, delayMs, jobId) => {
      queued.push({ payload, delayMs, ...(jobId ? { jobId } : {}) });
    },
  });
  return queued;
};

test('queues the next batch at once while the sync makes progress', async () => {
  assert.deepEqual(await run(result(100, true)), [{ payload: { events: true, attempt: 0 }, delayMs: 0 }]);
});

test('stops when no events remain', async () => {
  assert.deepEqual(await run(result(3, false)), []);
});

test('retries with a growing delay when nothing could be imported, then stops', async () => {
  assert.deepEqual(await run(result(0, true)), [{ payload: { events: true, attempt: 1 }, delayMs: 60_000 }]);
  assert.deepEqual(await run(new Error('Bridge unavailable'), 2), [
    { payload: { events: true, attempt: 3 }, delayMs: 240_000 },
  ]);
  assert.deepEqual((await run(result(0, true), 6))[0].delayMs, 15 * 60_000);
  assert.deepEqual(await run(result(0, true), 7), []);
});

test('names the follow-up job after the bridge key, so signals for the same batch fold into it', async () => {
  assert.deepEqual(await run(result(5, true, { jobKey: 'a1b2c3d4.7' })), [
    { payload: { events: true, attempt: 0 }, delayMs: 0, jobId: 'sync.a1b2c3d4.7' },
  ]);
});

test('waits as long as Twenty asks after a rate limit, without counting it as a failed attempt', async () => {
  assert.deepEqual(await run(result(0, true, { retryInMs: 4_200 }), 3), [
    { payload: { events: true, attempt: 3 }, delayMs: 4_200 },
  ]);
});

test('syncs receipts after the messages, and queues another run while receipts remain', async () => {
  const queued: { payload: object; delayMs: number }[] = [];
  const order: string[] = [];
  await runMessageSync({ events: true }, silentLogger, {
    sync: async () => {
      order.push('messages');
      return result(1, false);
    },
    syncDeliveryReceipts: async () => {
      order.push('receipts');
      return { updated: 200, remaining: true };
    },
    enqueue: async (payload, delayMs) => {
      queued.push({ payload, delayMs });
    },
  });

  assert.deepEqual(order, ['messages', 'receipts']);
  assert.deepEqual(queued, [{ payload: { events: true, attempt: 0 }, delayMs: 0 }]);
});
