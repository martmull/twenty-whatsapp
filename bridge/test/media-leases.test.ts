import assert from 'node:assert/strict';
import test from 'node:test';

import { MediaLeases } from '../src/media-leases.js';

test('limits concurrent media imports and frees the slot of a job that never released it', () => {
  const clock = { now: 0 };
  const leases = new MediaLeases(2, () => clock.now);
  const first = leases.claim();
  const second = leases.claim();

  assert.ok('leaseId' in first && 'leaseId' in second);
  assert.deepEqual(leases.claim(), { waitMs: 10_000 });

  assert.deepEqual(leases.release(first.leaseId), { released: true });
  assert.ok('leaseId' in leases.claim());

  clock.now += 6 * 60_000;
  assert.ok('leaseId' in leases.claim(), 'expired leases are reclaimed');
});
