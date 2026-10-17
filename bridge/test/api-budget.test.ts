import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiBudget } from '../src/api-budget.js';

test('grants background work while it leaves a reserve for live sync, then spreads waiting jobs out', () => {
  const clock = { now: 0 };
  const budget = new ApiBudget(100, () => clock.now);

  assert.deepEqual(budget.take(89, 'background'), { granted: true });
  assert.deepEqual(budget.take(2, 'background'), { granted: false, waitMs: 600 }, 'ten requests stay reserved');
  assert.deepEqual(
    budget.take(2, 'background'),
    { granted: false, waitMs: 1_800 },
    'the next waiting job comes back after the first one',
  );
  assert.deepEqual(budget.take(4, 'live'), { granted: true }, 'live sync uses the reserve');

  clock.now += 60_000;
  assert.deepEqual(budget.take(2, 'background'), { granted: true }, 'the budget refills over a minute');
});

test('lets live sync borrow a little, and corrects estimates with what jobs spent', () => {
  const clock = { now: 0 };
  const budget = new ApiBudget(100, () => clock.now);

  budget.adjust(100);
  assert.deepEqual(budget.take(20, 'live'), { granted: true }, 'down to a quarter of a minute in debt');
  assert.deepEqual(budget.take(10, 'live'), { granted: false, waitMs: 3_000 });
});

test('stops everything until Twenty’s rate limit window has passed', () => {
  const clock = { now: 0 };
  const budget = new ApiBudget(100, () => clock.now);

  budget.penalize(5_000);
  assert.deepEqual(budget.take(1, 'live'), { granted: false, waitMs: 5_000 });
  assert.equal((budget.take(1, 'background') as { waitMs: number }).waitMs >= 5_000, true);

  clock.now += 20_000;
  assert.deepEqual(budget.take(4, 'live'), { granted: true });
});
