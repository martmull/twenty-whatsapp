import { MetadataApiClient } from 'twenty-client-sdk/metadata';
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

type View = 'open' | 'mine' | 'closed' | 'all';
type ListRequest = { personId?: string; conversationId?: string; search?: string; before?: string; view?: View };
type Member = { id: string; name: { firstName?: string | null; lastName?: string | null } };

const VIEWS: View[] = ['open', 'mine', 'closed', 'all'];
// Conversations created before the status field have none: they count as open.
const OPEN_FILTER = { or: [{ status: { eq: 'OPEN' } }, { status: { is: 'NULL' } }] };

const viewFilter = (view: View, memberId: string | undefined) =>
  view === 'open'
    ? OPEN_FILTER
    : view === 'closed'
      ? { status: { eq: 'CLOSED' } }
      : view === 'mine'
        ? { ...OPEN_FILTER, assigneeId: { eq: memberId ?? '00000000-0000-0000-0000-000000000000' } }
        : {};

const loadCurrentMemberId = async (): Promise<string | undefined> => {
  const { currentUser } = await new MetadataApiClient().query({
    currentUser: { workspaceMember: { id: true } },
  });
  return currentUser?.workspaceMember?.id ?? undefined;
};

// The members a conversation can be assigned to, by name.
const loadMembers = async (): Promise<{ id: string; name: string }[]> => {
  const result = await userClient().query({
    workspaceMembers: {
      __args: { first: 200 },
      edges: { node: { id: true, name: { firstName: true, lastName: true } } },
    },
  });
  return nodesOf<Member>(result.workspaceMembers)
    .map((member) => ({
      id: member.id,
      name: [member.name?.firstName, member.name?.lastName].filter(Boolean).join(' ').trim() || member.id,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};
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
  // The Person widget shows every conversation of its Person; the inbox shows open ones by default.
  const view: View = event.body?.view ?? (personId ? 'all' : 'open');

  if (
    (personId && !isUuid(personId)) ||
    (conversationId && !isUuid(conversationId)) ||
    (search !== undefined && (typeof search !== 'string' || search.length > 100)) ||
    (before !== undefined && !Number.isFinite(Date.parse(before))) ||
    !VIEWS.includes(view)
  ) {
    throw new HttpError(400, 'Invalid request');
  }

  if (before) {
    if (!conversationId) throw new HttpError(400, 'Invalid request');
    return loadMessages(conversationId, before);
  }

  // The inbox needs the member list and who is asking (assignee menu, "Mine"); the Person widget does not.
  const [currentMemberId, members] = personId
    ? [undefined, undefined]
    : await Promise.all([loadCurrentMemberId().catch(() => undefined), loadMembers().catch(() => undefined)]);

  const [result, status] = await Promise.all([
    userClient().query({
      whatsappConversations: {
        __args: {
          filter: {
            ...viewFilter(view, currentMemberId),
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
    ...(members ? { members, currentMemberId } : {}),
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
