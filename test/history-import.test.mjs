import assert from 'node:assert/strict';
import test from 'node:test';

import { importHistoryMessagesForPerson } from '../src/logic-functions/message-data.ts';

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
        return { whatsappConversations: { edges: [{ node: { id: 'conversation-id', chatId, lastMessageAt } }] } };
      }

      const ids = selection.whatsappMessages.__args.filter.externalId.in;
      return { whatsappMessages: { edges: ids.filter((id) => existingIds.has(id)).map((externalId) => ({ node: { externalId } })) } };
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

  assert.equal(await importHistoryMessagesForPerson(client, 'account-id', events, { id: 'person-id', name: { firstName: 'Test' } }), 20);
  assert.equal(existingIds.size, 25);
  assert.equal(lastMessageAt, events.at(-1).sentAt);
  assert.equal(lastPreview, events.at(-1).text);
  assert.equal(requests.length, 4);

  requests.length = 0;
  assert.equal(await importHistoryMessagesForPerson(client, 'account-id', events, { id: 'person-id', name: { firstName: 'Test' } }), 0);
  assert.ok(requests.length <= 3);
});
