import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { syncMessages } from '../src/logic-functions/live-sync';
import { deterministicId } from '../src/logic-functions/record-writes';
import { createFakeTwenty, mockBridge } from './fake-twenty';

const ACCOUNT = { id: 'acc', phoneNumber: '+15559999999', state: 'CONNECTED' };
const SAVED_CHAT_ID = '15551234567@s.whatsapp.net';
const UNKNOWN_CHAT_ID = '15550000000@s.whatsapp.net';
const GROUP_ID = '120363123456789012@g.us';
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
let restore: () => void = () => undefined;

afterEach(() => restore());

const event = (chatId: string, index: number, sender?: { senderId: string; senderName: string }) => ({
  eventId: index.toString(16).padStart(64, '0'),
  chatId,
  providerMessageId: `provider-${index}`,
  direction: 'inbound' as const,
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 17, 12, index)).toISOString(),
  ...sender,
});

const bridgeWith = (savedContacts: (body: Record<string, unknown>) => unknown) => {
  const acknowledged: string[][] = [];
  const bridge = mockBridge({
    '/status': () => ({ state: 'connected', apiVersion: 2, phoneNumber: '15559999999', twentyAccountId: ACCOUNT.id }),
    '/events/claim': () => ({
      leaseId: '33333333-3333-4333-8333-333333333333',
      events: [
        event(SAVED_CHAT_ID, 1),
        event(UNKNOWN_CHAT_ID, 2),
        event(GROUP_ID, 3, { senderId: '777777777@lid', senderName: 'Sam' }),
        event(GROUP_ID, 4, { senderId: '15558888888@s.whatsapp.net', senderName: 'Stranger' }),
      ],
    }),
    '/contacts/saved': savedContacts,
    '/history/names': () => [
      { chatId: SAVED_CHAT_ID, name: 'Alex Martin', firstName: 'Alex', lastName: 'Martin' },
      { chatId: UNKNOWN_CHAT_ID, name: '+15550000000' },
      { chatId: GROUP_ID, name: 'Project team' },
    ],
    '/events/ack': (body) => acknowledged.push(body.eventIds as string[]),
    '/events/release': () => ({ released: true, remaining: false }),
  });
  restore = bridge.restore;
  return { calls: bridge.calls, acknowledged };
};

const groupConversation = { id: 'group-conversation', name: '120363123456789012', chatId: GROUP_ID, accountId: 'acc' };

test('creates People for saved contacts only, in one upsert, and names conversations after them', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], whatsappConversations: [{ ...groupConversation }] });
  const { calls, acknowledged } = bridgeWith(() => [
    { id: '777777777@lid', phoneNumber: '+15557777777', firstName: 'Sam', lastName: 'Lee' },
  ]);

  const result = await syncMessages(silentLogger, { client: twenty.client, queueFiles: async () => undefined });

  assert.deepEqual(twenty.requests, [
    'query people',
    'query whatsappConversations',
    'mutation createPeople',
    'mutation createWhatsappConversations',
    'mutation createWhatsappMessages',
  ]);
  assert.deepEqual(
    twenty.store.people.map((person) => [
      person.id,
      person.name,
      (person.phones as { primaryPhoneNumber: string }).primaryPhoneNumber,
    ]),
    [
      [deterministicId('person', '+15551234567'), { firstName: 'Alex', lastName: 'Martin' }, '+15551234567'],
      [deterministicId('person', '+15557777777'), { firstName: 'Sam', lastName: 'Lee' }, '+15557777777'],
    ],
  );
  const direct = twenty.store.whatsappConversations.find((conversation) => conversation.chatId === SAVED_CHAT_ID);
  assert.equal(direct?.name, 'Alex Martin');
  assert.equal(direct?.personId, deterministicId('person', '+15551234567'));
  const group = twenty.store.whatsappConversations.find((conversation) => conversation.chatId === GROUP_ID);
  assert.equal(group?.name, 'Project team');
  assert.equal(
    twenty.store.whatsappConversations.some((conversation) => conversation.chatId === UNKNOWN_CHAT_ID),
    false,
  );

  assert.equal(result.imported, 3);
  assert.equal(result.ignored, 1);
  assert.equal(acknowledged.flat().length, 4);
  const lookedUp = calls.find((call) => call.path === '/contacts/saved');
  assert.deepEqual(lookedUp?.body.ids, ['777777777@lid', '15558888888@s.whatsapp.net']);
});

test('keeps a saved contact queued when their Person cannot be created, and imports the rest', async () => {
  const twenty = createFakeTwenty({ whatsappAccounts: [ACCOUNT], whatsappConversations: [{ ...groupConversation }] });
  twenty.rejectRecords(
    (record) => (record.phones as { primaryPhoneNumber?: string } | undefined)?.primaryPhoneNumber === '+15551234567',
  );
  const { acknowledged } = bridgeWith(() => {
    throw new Error('bridge without saved contacts');
  });

  const result = await syncMessages(silentLogger, { client: twenty.client, queueFiles: async () => undefined });

  assert.equal(acknowledged.flat().includes(event(SAVED_CHAT_ID, 1).eventId), false);
  assert.equal(result.imported, 2, 'group messages still land without their senders as People');
  assert.equal(twenty.store.people.length, 0);
});
