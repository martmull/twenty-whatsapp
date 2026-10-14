import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgeJsonRequest, bridgeRequest } from 'src/logic-functions/bridge-request';
import { applicationClient, type Conversation, type Message, userClient } from 'src/logic-functions/message-data';

type ListRequest = { personId?: string; conversationId?: string };
type GroupMember = { id: string; phoneNumber?: string; displayName?: string; firstName?: string; lastName?: string };

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
      edges: { node: { id: true, name: true, chatId: true, personId: true, accountId: true, lastMessageAt: true, lastInboundAt: true, lastPreview: true } },
    },
  });
  const visibleConversations = (result.whatsappConversations?.edges ?? []).map(({ node }) => node as Conversation);
  const readStates = visibleConversations.length ? await applicationClient().query({
    whatsappConversationReadStates: {
      __args: { filter: { name: { in: visibleConversations.map((conversation) => `${event.userWorkspaceId}:${conversation.id}`) } }, first: visibleConversations.length },
      edges: { node: { name: true, lastReadAt: true } },
    },
  }) : undefined;
  const lastReadAtByName = new Map((readStates?.whatsappConversationReadStates?.edges ?? []).map(({ node }) => [node.name, node.lastReadAt]));
  const conversations = visibleConversations.map((conversation) => {
    const lastReadAt = lastReadAtByName.get(`${event.userWorkspaceId}:${conversation.id}`);
    return { ...conversation, lastReadAt, unread: Boolean(conversation.lastInboundAt && (!lastReadAt || conversation.lastInboundAt > lastReadAt)) };
  });
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
        edges: { node: { id: true, conversationId: true, externalId: true, direction: true, text: true, sentAt: true, deliveryState: true, requestId: true, senderId: true, senderName: true, mediaKind: true, media: { fileId: true, label: true, url: true } } },
      },
    });
    messages = (messageResult.whatsappMessages?.edges ?? []).map(({ node }) => node as Message).reverse();
  }

  const status = await bridgeRequest('/status').catch(() => ({ state: 'unavailable' as const }));
  if (selected?.chatId.endsWith('@g.us') && /^\d+$/.test(selected.name) && status.state === 'connected') {
    const history = await bridgeJsonRequest<{ name: string }>('/history/messages', {
      chatId: selected.chatId, rangeDays: 0, offset: 0, limit: 1,
    }).catch(() => undefined);
    if (history?.name && !/^\d+$/.test(history.name)) {
      await applicationClient().mutation({
        updateWhatsappConversation: {
          __args: { id: selected.id, data: { name: history.name.slice(0, 120) } },
          id: true,
        },
      }).catch(() => undefined);
      selected.name = history.name.slice(0, 120);
    }
  }
  const groupMembers = selected?.chatId.endsWith('@g.us') && status.state === 'connected'
    ? await bridgeJsonRequest<GroupMember[]>('/history/members', { chatId: selected.chatId }).catch(() => undefined)
    : undefined;

  return { conversations, selectedConversationId: selected?.id, messages, groupMembers, connectionState: status.state };
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
