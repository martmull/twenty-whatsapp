import { CoreApiClient } from 'twenty-client-sdk/core';

import { bridgePost } from 'src/logic-functions/bridge-request';
import { chunkRecords, MAX_UPSERT_RECORDS, upsertConversations } from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import { digits, isChatId, isEventId, isPhoneLikeName } from 'src/logic-functions/utils/validators';

export type Conversation = {
  id: string;
  name: string;
  chatId: string;
  personId?: string | null;
  accountId: string;
  lastMessageAt?: string | null;
  lastInboundAt?: string | null;
  lastPreview?: string | null;
};

export type Message = {
  id: string;
  conversationId: string;
  externalId?: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  text: string;
  sentAt: string;
  deliveryState: 'UNKNOWN' | 'SENT' | 'RECEIVED';
  requestId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  mediaKind?: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | null;
  media?: { fileId: string; label?: string | null; url?: string | null }[] | null;
};

export type Person = {
  id: string;
  name: { firstName?: string | null; lastName?: string | null };
  phones?: { primaryPhoneNumber?: string | null; primaryPhoneCallingCode?: string | null } | null;
};

// Message as queued by the bridge (lowercase values, converted when stored in Twenty).
export type BridgeMessageEvent = {
  eventId: string;
  chatId: string;
  providerMessageId: string;
  direction?: 'inbound' | 'outbound';
  text: string;
  sentAt: string;
  senderId?: string;
  senderName?: string;
  media?: { kind: 'image' | 'video' | 'audio'; mimeType: string; fileName: string; sizeBytes?: number };
};

// The records of a GraphQL connection (`edges[].node`), typed by the caller. The generated client
// marks every field optional, so callers state the fields they selected.
export const nodesOf = <T>(connection: { edges?: { node: unknown }[] } | null | undefined): T[] =>
  (connection?.edges ?? []).map((edge) => edge.node as T);

// Bridge media kinds as the values of the message mediaKind select field.
export const MEDIA_KIND_VALUES = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', document: 'DOCUMENT' } as const;

export const applicationClient = () => new CoreApiClient({ runAs: 'application' });
export const userClient = () => new CoreApiClient({ runAs: 'user' });

export const CONVERSATION_FIELDS = {
  id: true,
  name: true,
  chatId: true,
  personId: true,
  accountId: true,
  lastMessageAt: true,
  lastInboundAt: true,
  lastPreview: true,
} as const;
export const MESSAGE_FIELDS = {
  id: true,
  conversationId: true,
  externalId: true,
  direction: true,
  text: true,
  sentAt: true,
  deliveryState: true,
  requestId: true,
  senderId: true,
  senderName: true,
  mediaKind: true,
  media: { fileId: true, label: true, url: true },
} as const;

export const isValidBridgeEvent = (event: BridgeMessageEvent) =>
  isEventId(event.eventId) &&
  isChatId(event.chatId) &&
  Boolean(event.text) &&
  event.text.length <= 4096 &&
  (!event.direction || event.direction === 'inbound' || event.direction === 'outbound') &&
  Number.isFinite(Date.parse(event.sentAt));

export const personName = (person: Person) => [person.name.firstName, person.name.lastName].filter(Boolean).join(' ');

const personPhone = (person: Person): string => {
  const phone = person.phones?.primaryPhoneNumber ?? '';
  const callingCode = person.phones?.primaryPhoneCallingCode ?? '';

  if (phone.startsWith('+') || !callingCode) {
    return digits(phone);
  }

  return digits(callingCode) + digits(phone).replace(/^0/, '');
};

// The ways an international number like 33612345678 may be stored in a Person's primary phone.
const storedPhoneVariants = (number: string): string[] => {
  const variants = new Set([number, `+${number}`]);

  for (let callingCodeLength = 1; callingCodeLength <= 3; callingCodeLength += 1) {
    const national = number.slice(callingCodeLength);
    variants.add(national);
    variants.add(`0${national}`);
  }

  return [...variants];
};

// Returns the People whose primary phone matches each number (digits only, with country code).
export const findPeopleByPhones = async (client: CoreApiClient, numbers: string[]): Promise<Map<string, Person[]>> => {
  const wanted = new Set(numbers);
  const peopleByPhone = new Map<string, Person[]>();

  if (wanted.size === 0) {
    return peopleByPhone;
  }

  const result = await client.query({
    people: {
      __args: {
        filter: { phones: { primaryPhoneNumber: { in: [...wanted].flatMap(storedPhoneVariants) } } },
        first: 200,
      },
      edges: {
        node: {
          id: true,
          name: { firstName: true, lastName: true },
          phones: { primaryPhoneNumber: true, primaryPhoneCallingCode: true },
        },
      },
    },
  });

  for (const { node } of (result.people?.edges ?? []) as { node: Person }[]) {
    const number = personPhone(node);

    if (wanted.has(number)) {
      peopleByPhone.set(number, [...(peopleByPhone.get(number) ?? []), node]);
    }
  }

  return peopleByPhone;
};

export const ensureAccount = async (client: CoreApiClient, phoneNumber: string): Promise<string> => {
  const result = await client.query({
    whatsappAccounts: {
      __args: { filter: { phoneNumber: { eq: phoneNumber } }, first: 1 },
      edges: { node: { id: true, state: true } },
    },
  });
  const account = result.whatsappAccounts?.edges?.[0]?.node;

  if (!account) {
    const created = await client.mutation({
      createWhatsappAccount: { __args: { data: { name: phoneNumber, phoneNumber, state: 'CONNECTED' } }, id: true },
    });
    const id = created.createWhatsappAccount?.id;

    if (!id) {
      throw new Error('Could not create WhatsApp account');
    }

    return id;
  }

  if (account.state !== 'CONNECTED') {
    await client.mutation({
      updateWhatsappAccount: { __args: { id: account.id, data: { state: 'CONNECTED' } }, id: true },
    });
  }

  return account.id;
};

export const findConversation = async (
  client: CoreApiClient,
  accountId: string,
  chatId: string,
): Promise<Conversation | undefined> => {
  const result = await client.query({
    whatsappConversations: {
      __args: { filter: { accountId: { eq: accountId }, chatId: { eq: chatId } }, first: 1 },
      edges: { node: CONVERSATION_FIELDS },
    },
  });

  return result.whatsappConversations?.edges?.[0]?.node as Conversation | undefined;
};

export const findMessageByRequestId = async (
  client: CoreApiClient,
  requestId: string,
): Promise<Message | undefined> => {
  const result = await client.query({
    whatsappMessages: {
      __args: { filter: { requestId: { eq: requestId } }, first: 1 },
      edges: { node: MESSAGE_FIELDS },
    },
  });

  return result.whatsappMessages?.edges?.[0]?.node as Message | undefined;
};

// The fields a message import owns. The media file is left out: the media import attaches it.
export const messageRecord = (event: BridgeMessageEvent, conversationId: string): Record<string, unknown> => ({
  name: event.text.slice(0, 80),
  conversationId,
  externalId: event.eventId,
  direction: event.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND',
  text: event.text,
  sentAt: event.sentAt,
  deliveryState: event.direction === 'outbound' ? 'SENT' : 'RECEIVED',
  ...(event.media ? { mediaKind: MEDIA_KIND_VALUES[event.media.kind] } : {}),
  ...(event.senderId ? { senderId: event.senderId } : {}),
  ...(event.senderName ? { senderName: event.senderName } : {}),
});

export type ConversationSummary = {
  latest?: Pick<BridgeMessageEvent, 'sentAt' | 'text'>;
  latestInboundAt?: string;
};

export const summarizeEvents = (events: BridgeMessageEvent[]): ConversationSummary => ({
  latest: events.length
    ? events.reduce((current, event) => (event.sentAt > current.sentAt ? event : current))
    : undefined,
  latestInboundAt: events
    .filter((event) => event.direction !== 'outbound')
    .map((event) => event.sentAt)
    .sort()
    .pop(),
});

// The summary fields to write so the last message and last inbound time move forward, never
// backward. Nothing is written when the values would not change, so a replayed batch costs nothing.
export const summaryPatch = (
  conversation: Pick<Conversation, 'lastMessageAt' | 'lastInboundAt' | 'lastPreview'> | undefined,
  { latest, latestInboundAt }: ConversationSummary,
): Record<string, string> | undefined => {
  const lastMessageAt = conversation?.lastMessageAt;
  const updateLastMessage =
    latest &&
    (!lastMessageAt ||
      latest.sentAt > lastMessageAt ||
      (latest.sentAt === lastMessageAt && latest.text.slice(0, 160) !== conversation?.lastPreview));
  const updateLastInbound =
    latestInboundAt && (!conversation?.lastInboundAt || latestInboundAt > conversation.lastInboundAt);

  if (!updateLastMessage && !updateLastInbound) {
    return undefined;
  }

  return {
    ...(updateLastMessage ? { lastMessageAt: latest.sentAt, lastPreview: latest.text.slice(0, 160) } : {}),
    ...(updateLastInbound ? { lastInboundAt: latestInboundAt } : {}),
  };
};

export const updateConversationSummary = async (
  client: CoreApiClient,
  conversation: Pick<Conversation, 'id' | 'lastMessageAt' | 'lastInboundAt' | 'lastPreview'>,
  latest: Pick<BridgeMessageEvent, 'sentAt' | 'text'> | undefined,
  latestInboundAt: string | undefined,
): Promise<void> => {
  const patch = summaryPatch(conversation, { latest, latestInboundAt });

  if (patch) {
    await client.mutation({
      updateWhatsappConversation: { __args: { id: conversation.id, data: patch }, id: true },
    });
  }
};

export const findConversations = async (
  client: CoreApiClient,
  accountId: string,
  chatIds: string[],
): Promise<Map<string, Conversation>> => {
  if (chatIds.length === 0) {
    return new Map();
  }

  const result = await client.query({
    whatsappConversations: {
      __args: { filter: { accountId: { eq: accountId }, chatId: { in: chatIds } }, first: chatIds.length },
      edges: { node: CONVERSATION_FIELDS },
    },
  });

  return new Map(
    nodesOf<Conversation>(result.whatsappConversations).map((conversation) => [conversation.chatId, conversation]),
  );
};

type NameChanges = { version: number; full: boolean; names: { chatId: string; name: string }[] };
type NamedConversation = { id: string; chatId: string; name: string };

const renamesFor = (conversations: NamedConversation[], names: { chatId: string; name: string }[]) => {
  const nameByChatId = new Map(names.map(({ chatId, name }) => [chatId, name.trim().slice(0, 120)]));

  return conversations.flatMap((conversation) => {
    const name = nameByChatId.get(conversation.chatId);
    return name && !isPhoneLikeName(name) && name !== conversation.name ? [{ id: conversation.id, name }] : [];
  });
};

// Compares every conversation with the bridge's names, a page of 100 at a time (the bridge's limit).
const fullNameRenames = async (client: CoreApiClient): Promise<{ id: string; name: string }[]> => {
  const renames: { id: string; name: string }[] = [];
  let after: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await client.query({
      whatsappConversations: {
        __args: { first: 100, after },
        edges: { node: { id: true, chatId: true, name: true } },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });
    const conversations = nodesOf<NamedConversation>(result.whatsappConversations);

    if (conversations.length > 0) {
      const names = await bridgePost<{ chatId: string; name: string }[]>('/history/names', {
        chatIds: conversations.map((conversation) => conversation.chatId),
      });
      renames.push(...renamesFor(conversations, names));
    }

    after = result.whatsappConversations?.pageInfo?.endCursor ?? undefined;

    if (!result.whatsappConversations?.pageInfo?.hasNextPage || !after) {
      break;
    }
  }

  return renames;
};

// Updates conversation names from WhatsApp contact names, when the bridge signals name changes. The
// bridge lists the chats renamed since the last refresh, so a refresh costs one query and one upsert.
export const syncConversationNames = async (logger: Logger, client: CoreApiClient = applicationClient()) => {
  // A bridge from before name changes were tracked answers 404: compare every conversation.
  const changes = await bridgePost<NameChanges>('/history/names/changes').catch(
    () => ({ full: true, names: [] }) as Omit<NameChanges, 'version'> & { version?: number },
  );
  let renames: { id: string; name: string }[] = [];

  if (changes.full) {
    renames = await fullNameRenames(client);
  } else if (changes.names.length > 0) {
    for (const chunk of chunkRecords(changes.names)) {
      const result = await client.query({
        whatsappConversations: {
          __args: { filter: { chatId: { in: chunk.map(({ chatId }) => chatId) } }, first: MAX_UPSERT_RECORDS },
          edges: { node: { id: true, chatId: true, name: true } },
        },
      });
      renames.push(...renamesFor(nodesOf<NamedConversation>(result.whatsappConversations), chunk));
    }
  }

  if (renames.length > 0) {
    await upsertConversations(client, renames);
  }

  if (changes.version !== undefined) {
    await bridgePost('/history/names/changes/ack', { version: changes.version });
  }

  logger.info('Synced conversation names', { renamed: renames.length, full: changes.full });
};
