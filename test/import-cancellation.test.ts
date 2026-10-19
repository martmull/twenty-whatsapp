import assert from 'node:assert/strict';
import { test } from 'node:test';

import { historyJobId } from '../src/logic-functions/history-import';
import { cancelHistoryJobs, isHistoryJobCancelled } from '../src/logic-functions/import-cancellation';

const RUN_TOKEN = '22222222-2222-4222-8222-222222222222';
const OTHER_RUN_TOKEN = '33333333-3333-4333-8333-333333333333';

const memoryStore = () => {
  const values = new Map<string, unknown>();
  return {
    get: async <TValue>(key: string) => (values.get(key) as TValue) ?? null,
    set: async <TValue>(key: string, value: TValue) => {
      values.set(key, value);
    },
  };
};

test('marks every job of a cancelled chain, and only that chain', async () => {
  const store = memoryStore();

  await cancelHistoryJobs(RUN_TOKEN, store);

  assert.equal(await isHistoryJobCancelled(historyJobId(RUN_TOKEN, '0'), store), true);
  assert.equal(await isHistoryJobCancelled(historyJobId(RUN_TOKEN, '12-3'), store), true);
  assert.equal(await isHistoryJobCancelled(historyJobId(OTHER_RUN_TOKEN, '0'), store), false);
});

test('keeps the latest 20 cancelled chains', async () => {
  const store = memoryStore();
  const tokens = Array.from({ length: 25 }, (_, index) => `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`);

  for (const token of tokens) await cancelHistoryJobs(token, store);

  assert.equal(await isHistoryJobCancelled(historyJobId(tokens[0], '0'), store), false);
  assert.equal(await isHistoryJobCancelled(historyJobId(tokens[24], '0'), store), true);
});

test('treats an unreadable store as nothing cancelled', async () => {
  const store = { get: async () => Promise.reject(new Error('unavailable')), set: async () => undefined };

  assert.equal(await isHistoryJobCancelled(historyJobId(RUN_TOKEN, '0'), store as never), false);
});
