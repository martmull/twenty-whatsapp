import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { syncMessages } from '../src/logic-functions/live-sync';
import { deterministicId } from '../src/logic-functions/record-writes';
import { createFakeTwenty, mockBridge } from './fake-twenty';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const ACCOUNT = { id: 'acc', phoneNumber: '+15550000000', state: 'CONNECTED' };
const GROUP_ID = '120363123456789012@g.us';
let restore: () => void = () => undefined;

afterEach(() => restore());

const number = (index: number) => `1555${String(index).padStart(7, '0')}`;
const chatId = (index: number) => `${number(index)}@s.whatsapp.net`;
const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const event = (index: number, chat: string, overrides: Record<string, unknown> = {}) => ({
  eventId: index.toString(16).padStart(64, '0'),
  chatId: chat,
  providerMessageId: `provider-${index}`,
  direction: 'inbound' as const,
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  ...overrides,
});
const person = (index: number) => ({
  id: `person-${index}`,
  name: { firstName: 'Contact', lastName: `${index}` },
  phones: { primaryPhoneNumber: `+${number(index)}` },
});

type Event = ReturnType<typeof event>;

const bridgeWith = (events: Event[], status: Record<string, unknown> = { twentyAccountId: ACCOUNT.id }) => {
  const acknowledged: string[][] = [];
  const released: Record<string, unknown>[] = [];
  const remembered: Record<string, unknown>[] = [];
  const bridge = mockBridge({
    '/status': () => ({ state: 'connected', apiVersion: 2, phoneNumber: '15550000000', ...status }),
    '/events/claim': () => ({ leaseId: '33333333-3333-4333-8333-333333333333', events, jobKey: 'boot.2' }),
    '/events/ack': (body) => acknowledged.push(body.eventIds as string[]),
    '/events/release': (body) => {
      released.push(body);
      return { released: true, remaining: false, jobKey: 'boot.2' };
    },
    '/account': (body) => remembered.push(body),
  });
  restore = bridge.restore;
  return { acknowledged, released, remembered };
};

test('imports 200 events from 80 chats in 4 requests, then a replay creates nothing', async () => {
  const twenty = createFakeTwenty({
    whatsappAccounts: [ACCOUNT],
    people: range(80).map(person),
    whatsappConversations: range(40).map((index) => ({
      id: `conversation-${index}`,
      name: `Contact ${index}`,
      chatId: chatId(index),
      accountId: ACCOUNT.id,
      personId: `person-${index}`,
    })),
  });
  const events = range(200).map((index) => event(index, chatId(index % 80)));
  const { acknowledged, released } = bridgeWith(events);

  const result = await syncMessages(silentLogger, { client: twenty.client });

  assert.deepEqual(twenty.requests, [
    'query people',
    'query whatsappConversations',
    'mutation createWhatsappConversations',
    'mutation createWhatsappMessages',
  ]);
  assert.equal(result.imported, 200);
  assert.equal(result.jobKey, 'boot.2');
  assert.equal(twenty.store.whatsappMessages.length, 200);
  assert.equal(twenty.store.whatsappConversations.length, 80);
  assert.ok(
    twenty.store.whatsappConversations.some((row) => row.id === deterministicId('conversation', `acc:${chatId(79)}`)),
  );
  const latest = twenty.store.whatsappConversations.find((row) => row.chatId === chatId(79));
  assert.equal(latest?.lastPreview, 'Message 159');
  assert.equal(acknowledged.length, 1, 'one acknowledgement for the whole batch');
  assert.equal(acknowledged[0].length, 200);
  assert.equal(released[0].completed, true);

  twenty.requests.length = 0;
  const replay = await syncMessages(silentLogger, { client: twenty.client });
  assert.equal(replay.imported, 0);
  assert.equal(twenty.store.whatsappMessages.length, 200);
  assert.deepEqual(
    twenty.requests,
    ['query people', 'query whatsappConversations', 'mutation createWhatsappMessages'],
    'summaries that would not move forward are not written',
  );
});

test('looks the account up once and asks the bridge to remember it', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], people: [person(1)] });
  const { remembered } = bridgeWith([event(1, chatId(1))], {});

  await syncMessages(silentLogger, { client: twenty.client });

  assert.equal(twenty.requests[0], 'query whatsappAccounts');
  assert.deepEqual(remembered, [{ phoneNumber: ACCOUNT.phoneNumber, accountId: ACCOUNT.id }]);
});

test('skips unmatched chats and groups without a conversation, and keeps group senders', async () => {
  const twenty = createFakeTwenty({
    whatsappAccounts: [ACCOUNT],
    whatsappConversations: [{ id: 'group', name: 'Project team', chatId: GROUP_ID, accountId: ACCOUNT.id }],
  });
  const groupEvent = event(1, GROUP_ID, { senderId: '15551234567@s.whatsapp.net', senderName: 'Alex Martin' });
  const { acknowledged } = bridgeWith([groupEvent, event(2, chatId(5)), event(3, '120363000000000000@g.us')]);

  const result = await syncMessages(silentLogger, { client: twenty.client });

  assert.equal(result.imported, 1);
  assert.equal(result.ignored, 2);
  assert.equal(twenty.store.whatsappMessages[0].senderName, 'Alex Martin');
  assert.equal(twenty.store.whatsappMessages[0].conversationId, 'group');
  assert.equal(acknowledged[0].length, 3, 'skipped events are acknowledged too');
});

test('retries chat by chat when the batch cannot be written, keeping only the bad chat queued', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], people: range(3).map(person) });
  twenty.rejectRecords((record) => record.text === 'Message 1');
  const { acknowledged } = bridgeWith(range(3).map((index) => event(index, chatId(index))));

  const result = await syncMessages(silentLogger, { client: twenty.client });

  assert.equal(result.imported, 2);
  assert.deepEqual(acknowledged[0].sort(), [event(0, chatId(0)).eventId, event(2, chatId(2)).eventId].sort());
});

test('when Twenty rate limits, acknowledges nothing and waits as long as Twenty asks', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], people: [person(1)] });
  twenty.failNextRequest({
    errors: [{ message: 'Rate limit', extensions: { code: 'RATE_LIMITED', retryAfterMs: 4200 } }],
  });
  const { acknowledged, released } = bridgeWith([event(1, chatId(1))]);

  const result = await syncMessages(silentLogger, { client: twenty.client });

  assert.equal(result.retryInMs, 4200);
  assert.deepEqual(acknowledged, []);
  assert.equal(released[0].completed, false);
});

test('imports a whole batch with media, handing the files to the bridge media queue', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], people: [person(1)] });
  const media = { kind: 'image', mimeType: 'image/jpeg', fileName: 'photo.jpg' };
  const events = range(30).map((index) => event(index, chatId(1), index % 3 ? {} : { media }));
  bridgeWith(events);
  const queued: { eventId: string; fileName: string }[] = [];

  const result = await syncMessages(silentLogger, {
    client: twenty.client,
    queueFiles: async (items) => queued.push(...items),
  });

  assert.equal(result.imported, 30, 'media no longer cuts the batch short');
  assert.equal(queued.length, 10);
  assert.ok(queued.every((item) => item.fileName === 'photo.jpg'));
  assert.equal(twenty.store.whatsappMessages.filter((message) => message.mediaKind === 'IMAGE').length, 10);
});

test('waits as long as the bridge asks when its budget is spent, without touching Twenty', async () => {
  const twenty = createFakeTwenty();
  const bridge = mockBridge({
    '/status': () => ({ state: 'connected', phoneNumber: '15550000000', twentyAccountId: ACCOUNT.id }),
    '/events/claim': () => ({ events: [], jobKey: 'boot.9', waitMs: 1_500 }),
  });
  restore = bridge.restore;

  const result = await syncMessages(silentLogger, { client: twenty.client });

  assert.deepEqual(result, {
    imported: 0,
    ignored: 0,
    acknowledged: 0,
    remaining: true,
    jobKey: 'boot.9',
    retryInMs: 1_500,
  });
  assert.deepEqual(twenty.requests, []);
});

test('reports the requests a batch made, so the bridge can correct its estimate', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], people: [person(1)] });
  const { released } = bridgeWith([event(1, chatId(1))]);

  await syncMessages(silentLogger, { client: twenty.client });

  assert.equal(released[0].requests, twenty.requests.length);
});

test('keeps the events queued when their files cannot be handed to the media queue', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], people: [person(1)] });
  const media = { kind: 'image', mimeType: 'image/jpeg', fileName: 'photo.jpg' };
  const { acknowledged } = bridgeWith([event(1, chatId(1), { media })]);

  await assert.rejects(
    syncMessages(silentLogger, {
      client: twenty.client,
      queueFiles: async () => {
        throw new Error('WhatsApp bridge is unavailable');
      },
    }),
  );

  assert.deepEqual(acknowledged, []);
});

test('with a bridge older than the app, still imports the messages, without their files', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], people: [person(1)] });
  const media = { kind: 'image', mimeType: 'image/jpeg', fileName: 'photo.jpg' };
  const { acknowledged } = bridgeWith([event(1, chatId(1), { media })], {
    twentyAccountId: ACCOUNT.id,
    apiVersion: undefined,
  });
  let queued = 0;

  const result = await syncMessages(silentLogger, {
    client: twenty.client,
    queueFiles: async () => {
      queued += 1;
    },
  });

  assert.equal(result.imported, 1);
  assert.equal(queued, 0);
  assert.equal(acknowledged[0].length, 1);
});

test('reopens a closed conversation when the contact writes, and leaves it closed for own messages', async () => {
  const conversation = (index: number) => ({
    id: `conversation-${index}`,
    name: `Contact ${index}`,
    chatId: chatId(index),
    accountId: ACCOUNT.id,
    personId: `person-${index}`,
    status: 'CLOSED',
  });
  const twenty = createFakeTwenty({
    whatsappAccounts: [ACCOUNT],
    people: [person(0), person(1)],
    whatsappConversations: [conversation(0), conversation(1)],
  });
  bridgeWith([event(1, chatId(0)), event(2, chatId(1), { direction: 'outbound' })]);

  await syncMessages(silentLogger, { client: twenty.client });

  const statusOf = (index: number) =>
    (twenty.store.whatsappConversations as { id: string; status?: string }[]).find(
      (item) => item.id === `conversation-${index}`,
    )?.status;
  assert.equal(statusOf(0), 'OPEN');
  assert.equal(statusOf(1), 'CLOSED');
});
