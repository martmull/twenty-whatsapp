import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { mediaJobId, queueMedia, runMediaImport } from '../src/logic-functions/media-import';
import { createFakeTwenty, mockBridge } from './fake-twenty';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const RUN_TOKEN = '66666666-6666-4666-8666-666666666666';
const LEASE_ID = '55555555-5555-4555-8555-555555555555';
let restore: () => void = () => undefined;

afterEach(() => restore());

const item = (index: number) => ({
  messageId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  eventId: index.toString(16).padStart(64, '0'),
  fileName: `photo-${index}.jpg`,
});
type Item = ReturnType<typeof item>;
const fileId = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const messages = (count: number) =>
  range(count).map((index) => ({ id: item(index).messageId, externalId: item(index).eventId, mediaKind: 'IMAGE' }));

// Uploads every file but the ones listed as expired on WhatsApp.
const uploader =
  (expired: number[] = [], uploads: string[] = []) =>
  async (items: Item[]) => {
    uploads.push(...items.map((entry) => entry.eventId));
    return {
      writes: items
        .filter((entry) => !expired.some((index) => item(index).eventId === entry.eventId))
        .map((entry, index) => ({ id: entry.messageId, media: [{ fileId: fileId(index), label: entry.fileName }] })),
      processed: items.length,
    };
  };

const bridgeWith = (claim: unknown, step: Record<string, unknown> = { remaining: 3, seq: 2, nextJobKey: '2' }) => {
  const bridge = mockBridge({
    '/media/claim': () => claim,
    '/media/complete': () => step,
    '/media/release': () => step,
    '/budget/penalty': () => ({ penalized: true }),
  });
  restore = bridge.restore;
  return bridge.calls;
};

const run = async (
  twenty: ReturnType<typeof createFakeTwenty>,
  payload: Record<string, unknown>,
  upload = uploader(),
) => {
  const queued: { payload: Record<string, unknown>; delayMs: number; jobId?: string }[] = [];
  const result = await runMediaImport(payload as never, silentLogger, {
    client: twenty.client,
    enqueue: async (next, delayMs, jobId) => {
      queued.push({ payload: next as Record<string, unknown>, delayMs, jobId });
    },
    upload: upload as never,
  });
  return { result, queued };
};

test('hands files to the bridge queue and starts only the chains it asks for', async () => {
  const started: string[][] = [];
  const bridge = mockBridge({
    '/media/queue': (body) => ({ queued: (body.items as unknown[]).length, runTokens: [RUN_TOKEN] }),
  });
  restore = bridge.restore;

  await queueMedia(range(40).map(item), 'history', async (tokens) => {
    started.push(tokens);
  });

  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].body.source, 'history');
  assert.deepEqual(started, [[RUN_TOKEN]], 'one job to start, not one per file');
});

test('uploads the claimed files, attaches them in one request, then queues the chain’s next step', async () => {
  const twenty = createFakeTwenty({ whatsappMessages: messages(5) });
  const calls = bridgeWith({ leaseId: LEASE_ID, seq: 1, items: range(5).map(item) });

  const { result, queued } = await run(twenty, { runToken: RUN_TOKEN, seq: 1 }, uploader([3]));

  assert.deepEqual(result, { status: 'imported', attached: 4, remaining: 3 });
  assert.deepEqual(twenty.requests, ['mutation createWhatsappMessages']);
  assert.equal(twenty.store.whatsappMessages.filter((message) => message.media).length, 4);
  const complete = calls.find((call) => call.path === '/media/complete')?.body;
  assert.equal((complete?.processed as string[]).length, 5, 'an expired file is done with too');
  assert.deepEqual(queued, [
    { payload: { runToken: RUN_TOKEN, seq: 2 }, delayMs: 0, jobId: mediaJobId(RUN_TOKEN, '2') },
  ]);
});

test('ends the chain when no files remain', async () => {
  const twenty = createFakeTwenty({ whatsappMessages: messages(1) });
  bridgeWith({ leaseId: LEASE_ID, seq: 1, items: [item(1)] }, { remaining: 0 });

  const { queued } = await run(twenty, { runToken: RUN_TOKEN, seq: 1 });

  assert.deepEqual(queued, []);
});

test('comes back later when the bridge has no budget, without touching Twenty', async () => {
  const twenty = createFakeTwenty();
  bridgeWith({ waitMs: 4_000, seq: 1, nextJobKey: '1-1' });

  const { result, queued } = await run(twenty, { runToken: RUN_TOKEN, seq: 1 });

  assert.deepEqual(result, { status: 'waiting', delayMs: 4_000 });
  assert.deepEqual(twenty.requests, []);
  assert.equal(queued[0].jobId, mediaJobId(RUN_TOKEN, '1-1'));
});

test('after a rate limit, keeps its files and only attaches them on the retry', async () => {
  const twenty = createFakeTwenty({ whatsappMessages: messages(2) });
  twenty.failNextRequest({ errors: [{ extensions: { code: 'RATE_LIMITED', retryAfterMs: 3_000 } }] });
  const calls = bridgeWith({ leaseId: LEASE_ID, seq: 1, items: [item(1), item(2)] });
  const uploads: string[] = [];

  const first = await run(twenty, { runToken: RUN_TOKEN, seq: 1 }, uploader([], uploads));

  assert.deepEqual(first.result, { status: 'failed', delayMs: 3_000 });
  assert.equal(
    calls.some((call) => call.path === '/media/release'),
    false,
    'the lease is kept for the retry',
  );
  assert.deepEqual(calls.find((call) => call.path === '/budget/penalty')?.body, { retryAfterMs: 3_000 });
  const retry = first.queued[0];
  assert.equal(retry.jobId, mediaJobId(RUN_TOKEN, '1-r1'));

  await run(twenty, retry.payload, uploader([], uploads));
  assert.equal(uploads.length, 2, 'files are not uploaded twice');
  assert.equal(twenty.store.whatsappMessages.filter((message) => message.media).length, 2);
});

test('gives the files back after a failure and keeps the chain going', async () => {
  const twenty = createFakeTwenty({ whatsappMessages: messages(1) });
  twenty.rejectRecords(() => true);
  const calls = bridgeWith(
    { leaseId: LEASE_ID, seq: 1, items: [item(1)] },
    { remaining: 1, seq: 1, nextJobKey: '1-1' },
  );

  const { result, queued } = await run(twenty, { runToken: RUN_TOKEN, seq: 1 });

  assert.deepEqual(result, { status: 'failed', delayMs: 30_000 });
  assert.equal(calls.find((call) => call.path === '/media/release')?.body.failed, true);
  assert.equal(queued[0].jobId, mediaJobId(RUN_TOKEN, '1-1'));
});

test('a superseded chain stops without touching Twenty', async () => {
  const twenty = createFakeTwenty();
  bridgeWith({ stale: true });

  const { result, queued } = await run(twenty, { runToken: RUN_TOKEN, seq: 1 });

  assert.deepEqual(result, { status: 'idle' });
  assert.deepEqual(queued, []);
});
