import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { ApiBudget } from '../src/api-budget.js';
import { MAX_MEDIA_CHAINS, MEDIA_ITEMS_PER_CLAIM, MediaQueue, type MediaClaim } from '../src/media-queue.js';

import { MemoryStorage } from './memory-storage.js';

const item = (index: number, source: 'live' | 'history' = 'history') => ({
  messageId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  eventId: index.toString(16).padStart(64, '0'),
  fileName: `photo-${index}.jpg`,
  source,
});
const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

const withQueue = async (
  run: (
    queue: MediaQueue,
    clock: { now: number },
    world: { budget: ApiBudget; restarted: string[][] },
  ) => Promise<void>,
) => {
  const storage = new MemoryStorage();
  const clock = { now: Date.UTC(2026, 9, 18) };
  const world = { budget: new ApiBudget(100, () => clock.now), restarted: [] as string[][] };
  await run(
    new MediaQueue(storage, randomBytes(32), {
      now: () => clock.now,
      budget: world.budget,
      onChainsRestarted: (tokens) => world.restarted.push(tokens),
    }),
    clock,
    world,
  );
};

const asLease = (claim: MediaClaim) => {
  assert.ok('leaseId' in claim, 'expected files');
  return claim;
};

test('queues each file once and starts at most three chains, whatever the number of files', async () => {
  await withQueue(async (queue) => {
    const first = await queue.queue(range(40).map((index) => item(index)));
    assert.equal(first.queued, 40);
    assert.equal(first.runTokens.length, MAX_MEDIA_CHAINS);

    const again = await queue.queue(range(45).map((index) => item(index)));
    assert.equal(again.queued, 5, 'files already queued are skipped');
    assert.deepEqual(again.runTokens, [], 'running chains take the new files');
  });
});

test('each chain takes a few files at a time, and chains never share a file', async () => {
  await withQueue(async (queue) => {
    const { runTokens } = await queue.queue(range(12).map((index) => item(index)));
    const leases = await Promise.all(runTokens.map(async (token) => asLease(await queue.claim(token, 0))));
    const eventIds = leases.flatMap((lease) => lease.items.map((entry) => entry.eventId));

    assert.equal(leases[0].items.length, MEDIA_ITEMS_PER_CLAIM);
    assert.equal(new Set(eventIds).size, eventIds.length);
    assert.equal(eventIds.length, 12);
  });
});

test('completing removes the processed files, returns the rest, and ends the chain when empty', async () => {
  await withQueue(async (queue) => {
    const { runTokens } = await queue.queue(range(7).map((index) => item(index)));
    const [token] = runTokens;
    const lease = asLease(await queue.claim(token, 0));

    const step = await queue.complete(
      lease.leaseId,
      lease.items.slice(0, 3).map((entry) => entry.eventId),
    );
    assert.deepEqual(
      step,
      { remaining: 4, seq: 1, nextJobKey: '1', nextRunInMs: 2_000 },
      'files the job had no time for go back',
    );

    const next = asLease(await queue.claim(token, 1));
    assert.equal(next.items.length, 4);
    assert.deepEqual(
      await queue.complete(
        next.leaseId,
        next.items.map((entry) => entry.eventId),
      ),
      { remaining: 0 },
    );
    assert.deepEqual(await queue.claim(token, 2), { stale: true });
  });
});

test('a retry of a step gets its files back; a job for an older step stops', async () => {
  await withQueue(async (queue) => {
    const { runTokens } = await queue.queue([item(1)]);
    const lease = asLease(await queue.claim(runTokens[0], 0));

    assert.deepEqual(await queue.claim(runTokens[0], 0), lease);
    await queue.complete(lease.leaseId, []);
    assert.deepEqual(await queue.claim(runTokens[0], 0), { stale: true });
  });
});

test('drops a file that keeps failing', async () => {
  await withQueue(async (queue) => {
    const { runTokens } = await queue.queue([item(1)]);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await queue.claim(runTokens[0]);
      if (!('leaseId' in claim)) break;
      await queue.release(claim.leaseId, true, 0);
    }
    assert.deepEqual(await queue.claim(runTokens[0]), { stale: true }, 'the chain ended with its last file');
    assert.deepEqual((await queue.queue([])).runTokens, [], 'nothing is left to import');
  });
});

test('waits for the API budget, and cancels the files of a history import only', async () => {
  await withQueue(async (queue, _clock, world) => {
    const { runTokens } = await queue.queue([item(1, 'live'), item(2), item(3)]);
    world.budget.adjust(100);
    const wait = await queue.claim(runTokens[0], 0);
    assert.ok('waitMs' in wait && wait.nextJobKey === '0-1');

    assert.deepEqual(await queue.cancel('history'), { cancelled: 2 });
    world.budget.adjust(-200);
    const lease = asLease(await queue.claim(runTokens[0], 0));
    assert.deepEqual(
      lease.items.map((entry) => entry.source),
      ['live'],
    );
  });
});

test('replaces a chain whose job was lost', async () => {
  await withQueue(async (queue, clock, world) => {
    const { runTokens } = await queue.queue([item(1)]);
    clock.now += 2 * 60_000;

    const { runTokens: replaced } = await queue.recoverStalled();
    assert.equal(replaced.length, 1);
    assert.notEqual(replaced[0], runTokens[0]);
    assert.deepEqual(world.restarted, [replaced]);
    assert.deepEqual(await queue.claim(runTokens[0], 0), { stale: true });
    assert.ok('leaseId' in (await queue.claim(replaced[0], 0)));
  });
});
