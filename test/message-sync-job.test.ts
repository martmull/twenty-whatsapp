import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runMessageSync } from '../src/logic-functions/whatsapp-message-sync';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const result = (acknowledged: number, remaining: boolean) => ({
  imported: acknowledged,
  ignored: 0,
  acknowledged,
  remaining,
});

const run = async (outcome: Awaited<ReturnType<typeof result>> | Error, attempt = 0) => {
  const queued: { payload: object; delayMs: number }[] = [];
  await runMessageSync({ events: true, attempt }, silentLogger, {
    sync: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    enqueue: async (payload, delayMs) => {
      queued.push({ payload, delayMs });
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
