import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { historyJobId, runHistoryImportStep, type ChainPosition } from '../src/logic-functions/history-import';
import { createFakeTwenty, mockBridge } from './fake-twenty';

const RUN_TOKEN = '22222222-2222-4222-8222-222222222222';
const LEASE_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const CHAT_ID = '15551234567@s.whatsapp.net';
const OTHER_CHAT_ID = '15557654321@s.whatsapp.net';
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
let restore: () => void = () => undefined;

afterEach(() => restore());

const event = (index: number, chatId = CHAT_ID, overrides: Record<string, unknown> = {}) => ({
  eventId: index.toString(16).padStart(64, '0'),
  chatId,
  providerMessageId: `provider-${index}`,
  direction: index % 2 ? ('outbound' as const) : ('inbound' as const),
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  ...overrides,
});
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => offset + index);

const page = (overrides: Record<string, unknown> = {}) => ({
  leaseId: LEASE_ID,
  pageSeq: 4,
  chats: [
    {
      chatId: CHAT_ID,
      conversationId: CONVERSATION_ID,
      messages: range(150).map((index) => event(index)),
      isLastPage: true,
    },
    {
      chatId: OTHER_CHAT_ID,
      conversationId: OTHER_CONVERSATION_ID,
      messages: range(50, 1000).map((index) => event(index, OTHER_CHAT_ID)),
      isLastPage: false,
    },
  ],
  summaries: [],
  ...overrides,
});

const bridgeWith = (claim: unknown, step: Record<string, unknown> = { remaining: 1, pageSeq: 5, nextJobKey: '5' }) => {
  const calls = mockBridge({
    '/history/imports/claim': () => claim,
    '/history/imports/complete': () => step,
    '/history/imports/release': () => step,
  });
  restore = calls.restore;
  return calls.calls;
};

const run = async (
  twenty: ReturnType<typeof createFakeTwenty>,
  media: unknown[] = [],
  isCancelled = async (_jobId: string) => false,
) => {
  const scheduled: { runToken: string; delayMs: number; position?: ChainPosition }[] = [];
  const result = await runHistoryImportStep({ runToken: RUN_TOKEN, pageSeq: 4 }, silentLogger, {
    client: twenty.client,
    enqueue: async (runToken, delayMs, position) => {
      scheduled.push({ runToken, delayMs, position });
    },
    queueFiles: async (items) => media.push(...items),
    isCancelled,
  });
  return { result, scheduled };
};

test('imports a 200-message page of two chats in one request, then queues the next page', async () => {
  const twenty = createFakeTwenty();
  const calls = bridgeWith(page());

  const { result, scheduled } = await run(twenty);

  assert.equal(result.status, 'imported');
  assert.deepEqual(twenty.requests, ['mutation createWhatsappMessages']);
  assert.equal(twenty.store.whatsappMessages.length, 200);
  assert.deepEqual(calls.find((call) => call.path === '/history/imports/claim')?.body, {
    runToken: RUN_TOKEN,
    pageSeq: 4,
  });
  assert.deepEqual(calls.find((call) => call.path === '/history/imports/complete')?.body.imported, {
    [CHAT_ID]: 150,
    [OTHER_CHAT_ID]: 50,
  });
  assert.equal(scheduled.length, 1);
  assert.deepEqual(scheduled[0].position, { pageSeq: 5, jobKey: '5' });
  assert.equal(scheduled[0].delayMs, 0, 'the bridge paces the chain');
  assert.equal(calls.find((call) => call.path === '/history/imports/complete')?.body.requests, 1);
  assert.equal(historyJobId(RUN_TOKEN, '5'), `history.${RUN_TOKEN}.5`);
});

test('a page imported twice creates nothing the second time', async () => {
  const twenty = createFakeTwenty();
  bridgeWith(page());
  await run(twenty);

  const { result } = await run(twenty);

  assert.deepEqual(result.status === 'imported' && result.imported, 0);
  assert.equal(twenty.store.whatsappMessages.length, 200);
});

test('writes the summaries of finished chats in one query and one upsert, never moving them back', async () => {
  const twenty = createFakeTwenty({
    whatsappConversations: [
      { id: CONVERSATION_ID, name: 'A', chatId: CHAT_ID, accountId: 'acc', lastMessageAt: null },
      {
        id: OTHER_CONVERSATION_ID,
        name: 'B',
        chatId: OTHER_CHAT_ID,
        accountId: 'acc',
        lastMessageAt: '2027-01-01T00:00:00.000Z',
        lastInboundAt: '2027-01-01T00:00:00.000Z',
      },
    ],
  });
  bridgeWith(
    page({
      chats: [],
      summaries: [
        {
          chatId: CHAT_ID,
          conversationId: CONVERSATION_ID,
          lastMessage: { sentAt: event(9).sentAt, text: 'Latest' },
          lastInboundAt: event(8).sentAt,
        },
        {
          chatId: OTHER_CHAT_ID,
          conversationId: OTHER_CONVERSATION_ID,
          lastMessage: { sentAt: event(9).sentAt, text: 'Older' },
        },
      ],
    }),
    { remaining: 0, pageSeq: 5, nextJobKey: '5' },
  );

  const { scheduled } = await run(twenty);

  assert.deepEqual(twenty.requests, ['query whatsappConversations', 'mutation createWhatsappConversations']);
  const [first, second] = twenty.store.whatsappConversations;
  assert.equal(first.lastPreview, 'Latest');
  assert.equal(first.lastInboundAt, event(8).sentAt);
  assert.equal(second.lastMessageAt, '2027-01-01T00:00:00.000Z');
  assert.deepEqual(scheduled, [], 'the chain ends with its last page');
});

test('hands the files of the page to the bridge media queue', async () => {
  const twenty = createFakeTwenty();
  const media = { kind: 'image', mimeType: 'image/jpeg', fileName: 'photo.jpg' };
  bridgeWith(
    page({
      chats: [
        {
          chatId: CHAT_ID,
          conversationId: CONVERSATION_ID,
          messages: range(10).map((index) => event(index, CHAT_ID, index < 4 ? { media } : {})),
          isLastPage: true,
        },
      ],
    }),
  );
  const queued: unknown[] = [];

  await run(twenty, queued);

  assert.equal(queued.length, 4);
  assert.deepEqual(twenty.requests, ['mutation createWhatsappMessages'], 'files cost the page no request');
});

test('gives the page back without blaming its chats when Twenty rate limits, and waits as asked', async () => {
  const twenty = createFakeTwenty();
  twenty.failNextRequest({ errors: [{ extensions: { code: 'RATE_LIMITED', retryAfterMs: 7_000 } }] });
  const calls = bridgeWith(page(), { remaining: 2, pageSeq: 4, nextJobKey: '4-1' });

  const { result, scheduled } = await run(twenty);

  assert.equal(result.status, 'failed');
  assert.deepEqual(calls.find((call) => call.path === '/history/imports/release')?.body, {
    leaseId: LEASE_ID,
    failed: false,
    nextRunInMs: 7_000,
    requests: 1,
  });
  assert.deepEqual(scheduled, [{ runToken: RUN_TOKEN, delayMs: 7_000, position: { pageSeq: 4, jobKey: '4-1' } }]);
});

test('a superseded chain stops without touching Twenty', async () => {
  const twenty = createFakeTwenty();
  bridgeWith({ stale: true });

  const { result, scheduled } = await run(twenty);

  assert.deepEqual(result, { status: 'idle' });
  assert.deepEqual(twenty.requests, []);
  assert.deepEqual(scheduled, []);
});

test('without a page position from the bridge, queues the next job without a job ID', async () => {
  const twenty = createFakeTwenty();
  bridgeWith(page(), { remaining: 1 });

  const { scheduled } = await run(twenty);

  assert.equal(scheduled[0].position, undefined);
});

test('comes back for the same page when the bridge has no budget for it', async () => {
  const twenty = createFakeTwenty();
  bridgeWith({ waitMs: 2_500, pageSeq: 4, nextJobKey: '4-2' });

  const { result, scheduled } = await run(twenty);

  assert.deepEqual(result, { status: 'waiting', waitMs: 2_500 });
  assert.deepEqual(twenty.requests, []);
  assert.deepEqual(scheduled, [{ runToken: RUN_TOKEN, delayMs: 2_500, position: { pageSeq: 4, jobKey: '4-2' } }]);
});

test('reports a rate limit to the bridge, so other background jobs hold off too', async () => {
  const twenty = createFakeTwenty();
  twenty.failNextRequest({ errors: [{ extensions: { code: 'RATE_LIMITED', retryAfterMs: 9_000 } }] });
  const calls = bridgeWith(page(), { remaining: 1, pageSeq: 4, nextJobKey: '4-1' });

  await run(twenty);

  assert.deepEqual(calls.find((call) => call.path === '/budget/penalty')?.body, { retryAfterMs: 9_000 });
});

test('a job of a cancelled import stops before claiming anything', async () => {
  const twenty = createFakeTwenty();
  const calls = bridgeWith(page());
  const checked: string[] = [];

  const { result, scheduled } = await run(twenty, [], async (jobId) => {
    checked.push(jobId);
    return true;
  });

  assert.deepEqual(result, { status: 'idle' });
  assert.deepEqual(checked, [historyJobId(RUN_TOKEN, '4')]);
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduled, []);
});

test('stops, with a clear error, on a page from a bridge older than the app', async () => {
  const twenty = createFakeTwenty();
  const calls = bridgeWith({ leaseId: LEASE_ID, chatId: CHAT_ID, conversationId: CONVERSATION_ID, messages: [] });

  const { result, scheduled } = await run(twenty);

  assert.deepEqual(result, { status: 'idle' });
  assert.deepEqual(twenty.requests, []);
  assert.equal(calls.find((call) => call.path === '/history/imports/release')?.body.failed, false);
  assert.deepEqual(scheduled, []);
});

test('retries queueing the next page before leaving it to the bridge', async () => {
  const twenty = createFakeTwenty();
  bridgeWith(page());
  let attempts = 0;

  await runHistoryImportStep({ runToken: RUN_TOKEN, pageSeq: 4 }, silentLogger, {
    client: twenty.client,
    queueFiles: async () => undefined,
    isCancelled: async () => false,
    enqueue: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('Application job enqueue limit reached');
    },
  });

  assert.equal(attempts, 2);
});

test('drops the chats whose conversation was deleted and retries the others at once', async () => {
  const twenty = createFakeTwenty({
    whatsappConversations: [{ id: OTHER_CONVERSATION_ID, name: 'Sam', chatId: OTHER_CHAT_ID, accountId: 'acc' }],
  });
  twenty.failNextRequest(new Error('insert or update on table "_whatsappMessage" violates foreign key constraint'));
  const calls = bridgeWith(page(), { remaining: 1, pageSeq: 4, nextJobKey: '4-1' });

  const { result, scheduled } = await run(twenty);

  assert.equal(result.status, 'failed');
  assert.deepEqual(calls.find((call) => call.path === '/history/imports/release')?.body, {
    leaseId: LEASE_ID,
    failed: true,
    nextRunInMs: 0,
    requests: 2,
    abandonedChatIds: [CHAT_ID],
  });
  assert.equal(scheduled[0].delayMs, 0);
});
