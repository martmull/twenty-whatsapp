import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import {
  applicationClient,
  CONVERSATION_FIELDS,
  MESSAGE_FIELDS,
  userClient,
  type Conversation,
  type Message,
} from 'src/logic-functions/message-data';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { isGroupChatId, isUuid } from 'src/logic-functions/utils/validators';

type ListRequest = { personId?: string; conversationId?: string };
type GroupMember = { id: string; phoneNumber?: string; displayName?: string; isMe?: boolean };

const handler = route<ListRequest>('whatsapp-message-list', async (event) => {
  const userWorkspaceId = requireUser(event);
  const { personId, conversationId } = event.body ?? {};

  if ((personId && !isUuid(personId)) || (conversationId && !isUuid(conversationId))) {
    throw new HttpError(400, 'Invalid request');
  }

  const client = userClient();
  const result = await client.query({
    whatsappConversations: {
      __args: {
        filter: personId ? { personId: { eq: personId } } : {},
        first: 50,
        orderBy: [{ lastMessageAt: 'DescNullsLast' }],
      },
      edges: { node: CONVERSATION_FIELDS },
    },
  });
  const visibleConversations: Conversation[] = (result.whatsappConversations?.edges ?? []).map(({ node }: { node: Conversation }) => node);
  const readStates = visibleConversations.length ? await applicationClient().query({
    whatsappConversationReadStates: {
      __args: { filter: { name: { in: visibleConversations.map((conversation) => `${userWorkspaceId}:${conversation.id}`) } }, first: visibleConversations.length },
      edges: { node: { name: true, lastReadAt: true } },
    },
  }) : undefined;
  const lastReadAtByName = new Map((readStates?.whatsappConversationReadStates?.edges ?? []).map(({ node }: { node: { name: string; lastReadAt: string } }) => [node.name, node.lastReadAt]));
  const conversations = visibleConversations.map((conversation) => {
    const lastReadAt = lastReadAtByName.get(`${userWorkspaceId}:${conversation.id}`);
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
        edges: { node: MESSAGE_FIELDS },
      },
    });
    messages = (messageResult.whatsappMessages?.edges ?? []).map(({ node }: { node: Message }) => node).reverse();
  }

  const status = await getBridgeStatus().catch(() => ({ state: 'unavailable' as const }));
  const groupMembers = selected && isGroupChatId(selected.chatId) && status.state === 'connected'
    ? await bridgePost<GroupMember[]>('/history/members', { chatId: selected.chatId }).catch(() => undefined)
    : undefined;

  return { conversations, selectedConversationId: selected?.id, messages, groupMembers, connectionState: status.state };
});

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
