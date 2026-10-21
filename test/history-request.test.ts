import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { syncConversationNames } from '../src/logic-functions/message-data';
import { deterministicId } from '../src/logic-functions/record-writes';
import { queueImport } from '../src/logic-functions/whatsapp-history';
import { createFakeTwenty, mockBridge } from './fake-twenty';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const ACCOUNT = { id: 'acc', phoneNumber: '+15550000000', state: 'CONNECTED' };
let restore: () => void = () => undefined;

afterEach(() => restore());

const number = (group: number, index: number) => `155${group}${String(index).padStart(7, '0')}`;
const chatId = (group: number, index: number) => `${number(group, index)}@s.whatsapp.net`;
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

test('imports 50 chats, creating and renaming People and conversations, in 5 requests', async () => {
  const twenty = createFakeTwenty({
    whatsappAccounts: [ACCOUNT],
    people: [
      // Renamed: their name is still their phone number.
      ...range(10).map((index) => ({
        id: `renamed-${index}`,
        name: { firstName: `+${number(2, index)}`, lastName: '' },
        phones: { primaryPhoneNumber: `+${number(2, index)}` },
      })),
      ...range(10).map((index) => ({
        id: `named-${index}`,
        name: { firstName: 'Known', lastName: `${index}` },
        phones: { primaryPhoneNumber: `+${number(3, index)}` },
      })),
    ],
    whatsappConversations: range(10).map((index) => ({
      id: `conversation-${index}`,
      name: `+${number(3, index)}`,
      chatId: chatId(3, index),
      accountId: ACCOUNT.id,
      personId: `named-${index}`,
    })),
  });
  const queued: unknown[] = [];
  const bridge = mockBridge({
    '/history/names': (body) =>
      (body.chatIds as string[]).map((id) => ({ chatId: id, name: 'Ada Lovelace', firstName: 'Ada' })),
    '/history/imports/queue': (body) => {
      queued.push(...(body.tasks as unknown[]));
      return { queued: (body.tasks as unknown[]).length, runToken: '22222222-2222-4222-8222-222222222222' };
    },
  });
  restore = bridge.restore;
  const chats = [
    ...range(30).map((index) => ({ chatId: chatId(1, index), createPerson: true })),
    ...range(10).map((index) => ({ chatId: chatId(2, index) })),
    ...range(10).map((index) => ({ chatId: chatId(3, index) })),
  ];
  const request = { action: 'import' as const, rangeDays: 30, chats };
  const dependencies = { client: twenty.client, adminClient: twenty.client, enqueue: async () => undefined };

  const result = await queueImport(request, number(5, 0), true, silentLogger, dependencies);

  assert.deepEqual(result, { queued: 50, createdPeople: 30, failures: [] });
  assert.deepEqual(twenty.requests, [
    'query whatsappAccounts',
    'query people',
    'query whatsappConversations',
    'mutation createPeople',
    'mutation createWhatsappConversations',
  ]);
  assert.equal(twenty.store.people.length, 50);
  assert.ok(twenty.store.people.some((person) => person.id === deterministicId('person', `+${number(1, 0)}`)));
  assert.deepEqual(twenty.store.people.find((person) => person.id === 'renamed-0')?.name, {
    firstName: 'Ada',
    lastName: '',
  });
  assert.equal(twenty.store.whatsappConversations.length, 50);
  assert.equal(twenty.store.whatsappConversations.find((row) => row.id === 'conversation-0')?.name, 'Known 0');
  assert.equal(queued.length, 50);

  // Submitting the same import again finds everything and creates nothing twice.
  twenty.requests.length = 0;
  await queueImport(request, number(5, 0), true, silentLogger, dependencies);
  assert.equal(twenty.store.people.length, 50);
  assert.equal(twenty.store.whatsappConversations.length, 50);
  assert.deepEqual(twenty.requests, ['query whatsappAccounts', 'query people', 'query whatsappConversations']);
});

test('creates no People when the setting is off, even if the request asks for them', async () => {
  const twenty = createFakeTwenty({
    whatsappAccounts: [ACCOUNT],
    people: [
      { id: 'known', name: { firstName: 'Known', lastName: '' }, phones: { primaryPhoneNumber: `+${number(3, 0)}` } },
    ],
  });
  const memberLookups: unknown[] = [];
  const bridge = mockBridge({
    '/history/names': (body) =>
      (body.chatIds as string[]).map((id) => ({ chatId: id, name: 'Ada Lovelace', firstName: 'Ada' })),
    '/history/members': (body) => memberLookups.push(body.chatId),
    '/history/imports/queue': (body) => ({
      queued: (body.tasks as unknown[]).length,
      runToken: '22222222-2222-4222-8222-222222222222',
    }),
  });
  restore = bridge.restore;
  const request = {
    action: 'import' as const,
    rangeDays: 30,
    chats: [
      { chatId: chatId(1, 0), createPerson: true },
      { chatId: chatId(3, 0) },
      { chatId: '120363123456789012@g.us', createPerson: true },
    ],
  };

  const result = await queueImport(request, number(5, 0), false, silentLogger, {
    client: twenty.client,
    adminClient: twenty.client,
    enqueue: async () => undefined,
  });

  assert.deepEqual(result, {
    queued: 2,
    createdPeople: 0,
    failures: [{ chatId: chatId(1, 0), error: 'This contact is not matched to a Person' }],
  });
  assert.equal(twenty.store.people.length, 1);
  assert.deepEqual(memberLookups, []);
});

test('renames conversations from the names that changed, in one query and one upsert', async () => {
  const twenty = createFakeTwenty({
    whatsappConversations: range(200).map((index) => ({
      id: `conversation-${index}`,
      name: `+${number(1, index)}`,
      chatId: chatId(1, index),
      accountId: ACCOUNT.id,
    })),
  });
  const acknowledged: unknown[] = [];
  const bridge = mockBridge({
    '/history/names/changes': () => ({
      version: 7,
      full: false,
      names: range(200).map((index) => ({ chatId: chatId(1, index), name: index < 150 ? `Name ${index}` : '+1' })),
    }),
    '/history/names/changes/ack': (body) => acknowledged.push(body.version),
  });
  restore = bridge.restore;

  await syncConversationNames(silentLogger, twenty.client);

  assert.deepEqual(twenty.requests, ['query whatsappConversations', 'mutation createWhatsappConversations']);
  assert.equal(twenty.store.whatsappConversations.filter((row) => /^Name/.test(row.name as string)).length, 150);
  assert.deepEqual(acknowledged, [7]);
});

test('a refresh with no name changes makes no request to Twenty', async () => {
  const twenty = createFakeTwenty();
  const bridge = mockBridge({
    '/history/names/changes': () => ({ version: 3, full: false, names: [] }),
    '/history/names/changes/ack': () => ({ acknowledged: true }),
  });
  restore = bridge.restore;

  await syncConversationNames(silentLogger, twenty.client);

  assert.deepEqual(twenty.requests, []);
});

test('compares every conversation when the bridge asks for a full refresh, or cannot list changes', async () => {
  const twenty = createFakeTwenty({
    whatsappConversations: [{ id: 'conversation', name: '+15551234567', chatId: chatId(1, 0), accountId: 'acc' }],
  });
  const bridge = mockBridge({
    '/history/names': () => [{ chatId: chatId(1, 0), name: 'Grace Hopper' }],
  });
  restore = bridge.restore;

  await syncConversationNames(silentLogger, twenty.client);

  assert.equal(twenty.store.whatsappConversations[0].name, 'Grace Hopper');
  assert.deepEqual(twenty.requests, ['query whatsappConversations', 'mutation createWhatsappConversations']);
});
