import assert from 'node:assert/strict';
import test from 'node:test';

import { importChatMessages } from '../src/logic-functions/message-data.ts';

test('imports a history page in a few requests and skips existing messages on retry', async () => {
  const chatId = '1234567890@s.whatsapp.net';
  const events = Array.from({ length: 25 }, (_, index) => ({
    eventId: index.toString(16).padStart(64, '0'),
    chatId,
    providerMessageId: `provider-${index}`,
    direction: 'inbound',
    text: `Message ${index}`,
    sentAt: new Date(Date.UTC(2026, 9, 14, 9, index)).toISOString(),
  }));
  const existingIds = new Set(events.slice(0, 5).map((event) => event.eventId));
  const requests = [];
  let lastMessageAt;
  let lastPreview;

  const client = {
    query: async (selection) => {
      requests.push('query');

      if (selection.whatsappConversations) {
        return {
          whatsappConversations: { edges: [{ node: { id: 'conversation-id', name: 'Test', chatId, lastMessageAt } }] },
        };
      }

      const ids = selection.whatsappMessages.__args.filter.externalId.in;
      return {
        whatsappMessages: {
          edges: ids.filter((id) => existingIds.has(id)).map((externalId) => ({ node: { externalId } })),
        },
      };
    },
    mutation: async (selection) => {
      requests.push('mutation');

      if (selection.createWhatsappMessages) {
        const messages = selection.createWhatsappMessages.__args.data;
        messages.forEach((message) => existingIds.add(message.externalId));
        return { createWhatsappMessages: messages.map((_, index) => ({ id: `created-${index}` })) };
      }

      lastMessageAt = selection.updateWhatsappConversation.__args.data.lastMessageAt;
      lastPreview = selection.updateWhatsappConversation.__args.data.lastPreview;
      return { updateWhatsappConversation: { id: 'conversation-id' } };
    },
  };

  assert.equal(
    await importChatMessages(client, 'account-id', chatId, 'Test', events, {
      id: 'person-id',
      name: { firstName: 'Test' },
    }),
    20,
  );
  assert.equal(existingIds.size, 25);
  assert.equal(lastMessageAt, events.at(-1).sentAt);
  assert.equal(lastPreview, events.at(-1).text);
  assert.equal(requests.length, 4);

  requests.length = 0;
  assert.equal(
    await importChatMessages(client, 'account-id', chatId, 'Test', events, {
      id: 'person-id',
      name: { firstName: 'Test' },
    }),
    0,
  );
  assert.ok(requests.length <= 3);
});

test('imports a group without creating People and preserves each message sender', async () => {
  const chatId = '120363123456789012@g.us';
  const createdConversations = [];
  const createdMessages = [];
  const client = {
    query: async (selection) =>
      selection.whatsappConversations
        ? { whatsappConversations: { edges: createdConversations.map((node) => ({ node })) } }
        : { whatsappMessages: { edges: [] } },
    mutation: async (selection) => {
      if (selection.createWhatsappConversation) {
        const data = selection.createWhatsappConversation.__args.data;
        createdConversations.push({ ...data, id: 'group-conversation' });
        return { createWhatsappConversation: { id: 'group-conversation' } };
      }
      if (selection.createWhatsappMessages) {
        createdMessages.push(...selection.createWhatsappMessages.__args.data);
        return { createWhatsappMessages: createdMessages.map((_, index) => ({ id: `message-${index}` })) };
      }
      return { updateWhatsappConversation: { id: 'group-conversation' } };
    },
  };
  const event = {
    eventId: 'a'.repeat(64),
    chatId,
    providerMessageId: 'group-message',
    direction: 'inbound',
    text: 'Hello team',
    sentAt: new Date().toISOString(),
    senderId: '15551234567@s.whatsapp.net',
    senderName: 'Alex Martin',
  };

  assert.equal(await importChatMessages(client, 'account-id', chatId, 'Project team', [event]), 1);
  assert.equal(createdConversations[0].name, 'Project team');
  assert.equal(createdConversations[0].personId, undefined);
  assert.equal(createdMessages[0].senderName, 'Alex Martin');
  assert.equal(createdMessages[0].senderId, event.senderId);
});
