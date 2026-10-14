import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgeRequest } from 'src/logic-functions/bridge-request';
import { type Conversation, type Message, userClient } from 'src/logic-functions/message-data';

type ListRequest = { personId?: string; conversationId?: string };

const handler = async (event: RoutePayload<ListRequest>) => {
  if (!event.userWorkspaceId) {
    throw new Error('Authentication required');
  }

  const client = userClient();
  const personId = event.body?.personId;
  const conversationId = event.body?.conversationId;

  if (personId && !/^[a-f\d-]{36}$/i.test(personId)) {
    throw new Error('Invalid Person ID');
  }

  if (conversationId && !/^[a-f\d-]{36}$/i.test(conversationId)) {
    throw new Error('Invalid conversation ID');
  }

  const result = await client.query({
    whatsappConversations: {
      __args: {
        filter: personId ? { personId: { eq: personId } } : {},
        first: 50,
        orderBy: [{ lastMessageAt: 'DescNullsLast' }],
      },
      edges: { node: { id: true, name: true, chatId: true, personId: true, accountId: true, lastMessageAt: true, lastPreview: true } },
    },
  });
  const conversations = (result.whatsappConversations?.edges ?? []).map(({ node }) => node as Conversation);
  const selected = conversations.find((conversation) => conversation.id === conversationId) ?? conversations[0];
  let messages: Message[] = [];

  if (selected) {
    const messageResult = await client.query({
      whatsappMessages: {
        __args: {
          filter: { conversationId: { eq: selected.id } },
          first: 200,
          orderBy: [{ sentAt: 'DescNullsLast' }],
        },
        edges: { node: { id: true, conversationId: true, externalId: true, direction: true, text: true, sentAt: true, deliveryState: true, requestId: true, senderId: true, senderName: true } },
      },
    });
    messages = (messageResult.whatsappMessages?.edges ?? []).map(({ node }) => node as Message).reverse();
  }

  const status = await bridgeRequest('/status').catch(() => ({ state: 'disconnected' as const }));

  return { conversations, selectedConversationId: selected?.id, messages, connectionState: status.state };
};

export default defineLogicFunction({
  universalIdentifier: '44b14bc3-299c-49c0-acdd-ab801aaa89a1',
  name: 'whatsapp-message-list',
  description: 'List permitted WhatsApp conversations and messages.',
  timeoutSeconds: 20,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/messages/list',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
