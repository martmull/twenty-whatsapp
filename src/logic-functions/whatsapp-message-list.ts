import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import {
  applicationClient,
  CONVERSATION_FIELDS,
  MESSAGE_FIELDS,
  nodesOf,
  userClient,
  type Conversation,
  type Message,
} from 'src/logic-functions/message-data';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { isGroupChatId, isUuid } from 'src/logic-functions/utils/validators';

type ListRequest = { personId?: string; conversationId?: string; search?: string; before?: string };
type GroupMember = { id: string; phoneNumber?: string; displayName?: string; isMe?: boolean };

const MESSAGE_PAGE_SIZE = 100;

// Newest messages of a conversation, or the page before `before` when loading older ones.
const loadMessages = async (conversationId: string, before?: string) => {
  const result = await userClient().query({
    whatsappMessages: {
      __args: {
        filter: { conversationId: { eq: conversationId }, ...(before ? { sentAt: { lt: before } } : {}) },
        first: MESSAGE_PAGE_SIZE,
        orderBy: [{ sentAt: 'DescNullsLast' }],
      },
      edges: { node: MESSAGE_FIELDS },
      pageInfo: { hasNextPage: true },
    },
  });

  return {
    messages: nodesOf<Message>(result.whatsappMessages).reverse(),
    hasMoreMessages: Boolean(result.whatsappMessages?.pageInfo?.hasNextPage),
  };
};

// One conversation by ID, if this member may read it.
const loadConversation = async (conversationId: string): Promise<Conversation | undefined> => {
  const result = await userClient().query({
    whatsappConversations: {
      __args: { filter: { id: { eq: conversationId } }, first: 1 },
      edges: { node: CONVERSATION_FIELDS },
    },
  });

  return nodesOf<Conversation>(result.whatsappConversations)[0];
};

const loadLastReadAt = async (userWorkspaceId: string, conversations: Conversation[]) => {
  if (conversations.length === 0) {
    return new Map<string, string>();
  }

  const result = await applicationClient().query({
    whatsappConversationReadStates: {
      __args: {
        filter: { name: { in: conversations.map((conversation) => `${userWorkspaceId}:${conversation.id}`) } },
        first: conversations.length,
      },
      edges: { node: { name: true, lastReadAt: true } },
    },
  });

  return new Map(
    nodesOf<{ name: string; lastReadAt: string }>(result.whatsappConversationReadStates).map((readState) => [
      readState.name,
      readState.lastReadAt,
    ]),
  );
};

const handler = route<ListRequest>('whatsapp-message-list', async (event) => {
  const userWorkspaceId = requireUser(event);
  const { personId, conversationId, search, before } = event.body ?? {};

  if (
    (personId && !isUuid(personId)) ||
    (conversationId && !isUuid(conversationId)) ||
    (search !== undefined && (typeof search !== 'string' || search.length > 100)) ||
    (before !== undefined && !Number.isFinite(Date.parse(before)))
  ) {
    throw new HttpError(400, 'Invalid request');
  }

  if (before) {
    if (!conversationId) throw new HttpError(400, 'Invalid request');
    return loadMessages(conversationId, before);
  }

  const [result, status] = await Promise.all([
    userClient().query({
      whatsappConversations: {
        __args: {
          filter: {
            ...(personId ? { personId: { eq: personId } } : {}),
            ...(search?.trim() ? { name: { ilike: `%${search.trim()}%` } } : {}),
          },
          first: 50,
          orderBy: [{ lastMessageAt: 'DescNullsLast' }],
        },
        edges: { node: CONVERSATION_FIELDS },
      },
    }),
    getBridgeStatus().catch(() => ({ state: 'unavailable' as const })),
  ]);
  const visibleConversations = nodesOf<Conversation>(result.whatsappConversations);
  // The open conversation stays open when a search, or the 50-conversation limit, leaves it out of the list.
  const selected =
    visibleConversations.find((conversation) => conversation.id === conversationId) ??
    (conversationId ? await loadConversation(conversationId) : undefined) ??
    visibleConversations[0];
  const readStateConversations =
    selected && !visibleConversations.includes(selected) ? [...visibleConversations, selected] : visibleConversations;

  const [lastReadAtByName, thread, groupMembers] = await Promise.all([
    loadLastReadAt(userWorkspaceId, readStateConversations),
    selected ? loadMessages(selected.id) : { messages: [], hasMoreMessages: false },
    selected && isGroupChatId(selected.chatId) && status.state === 'connected'
      ? bridgePost<GroupMember[]>('/history/members', { chatId: selected.chatId }).catch(() => undefined)
      : undefined,
  ]);

  const withReadState = (conversation: Conversation) => {
    const lastReadAt = lastReadAtByName.get(`${userWorkspaceId}:${conversation.id}`);
    return {
      ...conversation,
      lastReadAt,
      unread: Boolean(conversation.lastInboundAt && (!lastReadAt || conversation.lastInboundAt > lastReadAt)),
    };
  };

  return {
    conversations: visibleConversations.map(withReadState),
    selectedConversationId: selected?.id,
    selectedConversation: selected ? withReadState(selected) : undefined,
    ...thread,
    groupMembers,
    connectionState: status.state,
  };
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
