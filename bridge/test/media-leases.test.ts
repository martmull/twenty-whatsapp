import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiBudget } from '../src/api-budget.js';
import { MediaLeases } from '../src/media-leases.js';

test('limits concurrent media imports and frees the slot of a job that never released it', () => {
  const clock = { now: 0 };
  const leases = new MediaLeases(2, () => clock.now);
  const first = leases.claim();
  const second = leases.claim();

  assert.ok('leaseId' in first && 'leaseId' in second);
  assert.deepEqual(leases.claim(), { waitMs: 7_500 });
  assert.deepEqual(leases.claim(), { waitMs: 15_000 }, 'waiting jobs get successive slots');

  assert.deepEqual(leases.release(first.leaseId), { released: true });
  assert.ok('leaseId' in leases.claim());

  clock.now += 6 * 60_000;
  assert.ok('leaseId' in leases.claim(), 'expired leases are reclaimed');
});

test('a media job waits when the API budget is spent, and reports what it used', () => {
  const clock = { now: 0 };
  const budget = new ApiBudget(10, () => clock.now);
  const leases = new MediaLeases(3, () => clock.now, budget);

  budget.adjust(9);
  assert.ok('waitMs' in leases.claim(), 'one request is reserved for live sync');
  clock.now += 60_000;
  const claimed = leases.claim();
  assert.ok('leaseId' in claimed);
  leases.release(claimed.leaseId, 9);
  assert.ok('waitMs' in leases.claim(), 'the extra requests are charged');
});
