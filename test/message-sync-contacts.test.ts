import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { syncMessages } from '../src/logic-functions/message-data';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const SAVED_CHAT_ID = '15551234567@s.whatsapp.net';
const UNKNOWN_CHAT_ID = '15550000000@s.whatsapp.net';
const GROUP_ID = '120363123456789012@g.us';
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const event = (chatId: string, index: number, sender?: { senderId: string; senderName: string }) => ({
  eventId: index.toString(16).padStart(64, '0'),
  chatId,
  providerMessageId: `provider-${index}`,
  direction: 'inbound' as const,
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 17, 12, index)).toISOString(),
  ...sender,
});

let bridgeCalls: { path: string; body: Record<string, unknown> }[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.test';
  process.env.WHATSAPP_BRIDGE_TOKEN = 'token';
  bridgeCalls = [];
  const responses: Record<string, unknown> = {
    '/status': { state: 'connected', phoneNumber: '15559999999' },
    '/events/claim': {
      leaseId: 'lease',
      events: [
        event(SAVED_CHAT_ID, 1),
        event(UNKNOWN_CHAT_ID, 2),
        event(GROUP_ID, 3, { senderId: '777777777@lid', senderName: 'Sam' }),
        event(GROUP_ID, 4, { senderId: '15558888888@s.whatsapp.net', senderName: 'Stranger' }),
      ],
    },
    '/contacts/saved': [{ id: '777777777@lid', phoneNumber: '+15557777777', firstName: 'Sam', lastName: 'Lee' }],
    '/history/names': [
      { chatId: SAVED_CHAT_ID, name: 'Alex Martin', firstName: 'Alex', lastName: 'Martin' },
      { chatId: UNKNOWN_CHAT_ID, name: '+15550000000' },
      { chatId: GROUP_ID, name: 'Project team' },
    ],
    '/events/release': { remaining: false },
  };
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    bridgeCalls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(responses[path] ?? {}));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Selection = Record<string, { __args?: { data?: unknown; id?: string } }>;

const fakeClient = () => {
  const mutations: { name: string; args: { data?: unknown; id?: string } }[] = [];
  let personCount = 0;
  const client = {
    query: async (selection: Selection) => {
      if (selection.whatsappAccounts) {
        return { whatsappAccounts: { edges: [{ node: { id: ACCOUNT_ID, state: 'CONNECTED' } }] } };
      }
      if (selection.whatsappConversations) {
        return {
          whatsappConversations: {
            edges: [
              {
                node: {
                  id: GROUP_CONVERSATION_ID,
                  name: '120363123456789012',
                  chatId: GROUP_ID,
                  accountId: ACCOUNT_ID,
                },
              },
            ],
          },
        };
      }
      if (selection.people) return { people: { edges: [] } };
      return { whatsappMessages: { edges: [] } };
    },
    mutation: async (selection: Selection) => {
      const [name, { __args = {} }] = Object.entries(selection)[0];
      mutations.push({ name, args: __args });
      if (name === 'createPeople') {
        const data = __args.data as { name: object; phones: { primaryPhoneNumber: string } }[];
        return {
          createPeople: data.map((person) => ({ id: `person-${(personCount += 1)}`, ...person })),
        };
      }
      if (name === 'createWhatsappMessages') {
        return { createWhatsappMessages: (__args.data as unknown[]).map((_, index) => ({ id: `message-${index}` })) };
      }
      return { [name]: { id: 'conversation-new' } };
    },
  };
  return { client, mutations };
};

test('creates People for saved contacts only, and names conversations after them', async () => {
  const { client, mutations } = fakeClient();

  const result = await syncMessages(silentLogger, client as never);

  const createdPeople = mutations
    .filter((mutation) => mutation.name === 'createPeople')
    .flatMap((mutation) => mutation.args.data as { name: object; phones: { primaryPhoneNumber: string } }[]);
  assert.deepEqual(createdPeople.map((person) => [person.name, person.phones.primaryPhoneNumber]).sort(), [
    [{ firstName: 'Alex', lastName: 'Martin' }, '+15551234567'],
    [{ firstName: 'Sam', lastName: 'Lee' }, '+15557777777'],
  ]);

  const createdConversation = mutations.find((mutation) => mutation.name === 'createWhatsappConversation');
  assert.deepEqual(createdConversation?.args.data, {
    name: 'Alex Martin',
    chatId: SAVED_CHAT_ID,
    accountId: ACCOUNT_ID,
    personId: 'person-1',
  });

  const renamed = mutations.find(
    (mutation) =>
      mutation.name === 'updateWhatsappConversation' &&
      mutation.args.id === GROUP_CONVERSATION_ID &&
      (mutation.args.data as { name?: string }).name,
  );
  assert.equal((renamed?.args.data as { name: string }).name, 'Project team');

  assert.equal(result.imported, 3);
  assert.equal(result.ignored, 1);
  assert.equal(result.acknowledged, 4);
  const lookedUp = bridgeCalls.find((call) => call.path === '/contacts/saved');
  assert.deepEqual(lookedUp?.body.ids, ['777777777@lid', '15558888888@s.whatsapp.net']);
});
