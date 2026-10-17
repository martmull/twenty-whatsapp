import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { mediaImportJobs, mediaJobId, runMediaImport } from '../src/logic-functions/media-import';
import { createFakeTwenty, mockBridge } from './fake-twenty';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const LEASE_ID = '55555555-5555-4555-8555-555555555555';
let restore: () => void = () => undefined;

afterEach(() => restore());

const item = (index: number) => ({
  messageId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  eventId: index.toString(16).padStart(64, '0'),
  fileName: `photo-${index}.jpg`,
});
const fileId = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

const bridgeWith = (claim: Record<string, unknown> = { leaseId: LEASE_ID }) => {
  const released: unknown[] = [];
  const bridge = mockBridge({
    '/media/claim': () => claim,
    '/media/release': (body) => released.push(body.leaseId),
  });
  restore = bridge.restore;
  return { released };
};

const messages = (count: number) =>
  range(count).map((index) => ({ id: item(index).messageId, externalId: item(index).eventId, mediaKind: 'IMAGE' }));

test('groups files five per job, with the same job ID for the same files in any order', () => {
  const items = range(12).map(item);
  const jobs = mediaImportJobs(items);

  assert.deepEqual(
    jobs.map((job) => job.payload.items?.length),
    [5, 5, 2],
  );
  assert.equal(jobs[0].jobId, mediaJobId({ items: [...items.slice(0, 5)].reverse() }));
  assert.match(jobs[0].jobId, /^media\.[a-f\d]{40}$/);
  assert.notEqual(jobs[0].jobId, jobs[1].jobId);
});

test('uploads a group of files and attaches them in one request, skipping expired media', async () => {
  const twenty = createFakeTwenty({ whatsappMessages: messages(5) });
  const { released } = bridgeWith();

  const result = await runMediaImport({ items: range(5).map(item) }, silentLogger, {
    client: twenty.client,
    upload: async (items) => ({
      writes: items
        .slice(1)
        .map((entry, index) => ({ id: entry.messageId, media: [{ fileId: fileId(index), label: entry.fileName }] })),
      processed: items.length,
    }),
  });

  assert.deepEqual(result, { status: 'imported', attached: 4, requeued: 0 });
  assert.deepEqual(twenty.requests, ['mutation createWhatsappMessages']);
  assert.equal(twenty.store.whatsappMessages.filter((message) => message.media).length, 4);
  assert.deepEqual(released, [LEASE_ID]);
});

test('waits for a free media slot without touching Twenty', async () => {
  const twenty = createFakeTwenty();
  bridgeWith({ waitMs: 10_000 });
  const queued: { payload: unknown; delayMs: number; jobId: string }[] = [];
  const payload = { items: [item(1)] };

  const result = await runMediaImport(payload, silentLogger, {
    client: twenty.client,
    enqueue: async (next, delayMs, jobId) => {
      queued.push({ payload: next, delayMs, jobId });
    },
  });

  assert.deepEqual(result, { status: 'requeued', delayMs: 10_000 });
  assert.deepEqual(twenty.requests, []);
  assert.equal(queued[0].jobId, `${mediaJobId(payload)}.1`);
});

test('after a rate limit, retries only the attach with the files already uploaded', async () => {
  const twenty = createFakeTwenty({ whatsappMessages: messages(2) });
  twenty.failNextRequest({ errors: [{ extensions: { code: 'RATE_LIMITED', retryAfterMs: 3_000 } }] });
  const { released } = bridgeWith();
  const queued: { payload: { items?: unknown[]; uploaded?: unknown[]; attempt?: number }; delayMs: number }[] = [];
  let uploads = 0;
  const dependencies = {
    client: twenty.client,
    enqueue: async (payload: (typeof queued)[number]['payload'], delayMs: number) => {
      queued.push({ payload, delayMs });
    },
    upload: async (items: ReturnType<typeof item>[]) => {
      uploads += items.length;
      return {
        writes: items.map((entry, index) => ({ id: entry.messageId, media: [{ fileId: fileId(index), label: 'a' }] })),
        processed: items.length,
      };
    },
  };

  const result = await runMediaImport({ items: [item(1), item(2)] }, silentLogger, dependencies);

  assert.deepEqual(result, { status: 'requeued', delayMs: 3_000 });
  assert.deepEqual(released, [LEASE_ID]);
  assert.deepEqual(queued[0].payload.items, []);
  assert.equal(queued[0].payload.uploaded?.length, 2);

  await runMediaImport(queued[0].payload as never, silentLogger, dependencies);
  assert.equal(uploads, 2, 'files are not uploaded twice');
  assert.equal(twenty.store.whatsappMessages.filter((message) => message.media).length, 2);
});

test('queues the files it had no time for as a new job', async () => {
  const twenty = createFakeTwenty({ whatsappMessages: messages(5) });
  bridgeWith();
  const queued: { payload: { items?: unknown[] }; jobId: string }[] = [];

  const result = await runMediaImport({ items: range(5).map(item) }, silentLogger, {
    client: twenty.client,
    enqueue: async (payload, _delayMs, jobId) => {
      queued.push({ payload, jobId });
    },
    upload: async (items) => ({
      writes: items.slice(0, 2).map((entry) => ({ id: entry.messageId, media: [{ fileId: fileId(1), label: 'a' }] })),
      processed: 2,
    }),
  });

  assert.deepEqual(result, { status: 'imported', attached: 2, requeued: 3 });
  assert.equal(queued[0].payload.items?.length, 3);
  assert.equal(queued[0].jobId, mediaJobId({ items: range(5).map(item).slice(2) }));
});

test('gives up only after the bridge stayed unreachable, not after waiting for a slot', async () => {
  const queued: { payload: { attempt?: number; failures?: number } }[] = [];
  const enqueue = async (payload: { attempt?: number; failures?: number }) => {
    queued.push({ payload });
  };
  const twenty = createFakeTwenty();

  bridgeWith({ waitMs: 5_000 });
  await runMediaImport({ items: [item(1)], attempt: 20, failures: 7 }, silentLogger, {
    client: twenty.client,
    enqueue,
  });
  assert.deepEqual(queued[0].payload, { items: [item(1)], uploaded: [], attempt: 21, failures: 7 });

  restore();
  const bridge = mockBridge({});
  restore = bridge.restore;
  const result = await runMediaImport({ items: [item(1)], attempt: 21, failures: 7 }, silentLogger, {
    client: twenty.client,
    enqueue,
  });
  assert.deepEqual(result, { status: 'dropped' });
});
