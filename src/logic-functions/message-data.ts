import { CoreApiClient } from 'twenty-client-sdk/core';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import { importMessageMedia } from 'src/logic-functions/message-media';
import type { Logger } from 'src/logic-functions/utils/logger';
import {
  chatNumber,
  digits,
  isChatId,
  isDirectChatId,
  isEventId,
  isGroupChatId,
  isPhoneLikeName,
} from 'src/logic-functions/utils/validators';

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

const attachMedia = async (client: CoreApiClient, event: BridgeMessageEvent): Promise<void> => {
  const result = await client.query({
    whatsappMessages: {
      __args: { filter: { externalId: { eq: event.eventId } }, first: 1 },
      edges: { node: { id: true, media: { fileId: true } } },
    },
  });
  const message = result.whatsappMessages?.edges?.[0]?.node;

  if (!message || message.media?.length) {
    return;
  }

  const file = await importMessageMedia(event);

  if (file) {
    await client.mutation({
      updateWhatsappMessage: { __args: { id: message.id, data: { media: [file] } }, id: true },
    });
  }
};

// Stores a batch of messages from one chat, creating the conversation when needed. Safe to retry.
export const importChatMessages = async (
  client: CoreApiClient,
  accountId: string,
  chatId: string,
  name: string,
  events: BridgeMessageEvent[],
  person?: Person,
): Promise<number> => {
  if (!isChatId(chatId) || events.some((event) => event.chatId !== chatId || !isValidBridgeEvent(event))) {
    throw new Error('Invalid bridge event');
  }

  let conversation = await findConversation(client, accountId, chatId);

  if (!conversation) {
    const created = await client.mutation({
      createWhatsappConversation: {
        __args: { data: { name, chatId, accountId, ...(person ? { personId: person.id } : {}) } },
        id: true,
      },
    });
    const id = created.createWhatsappConversation?.id;

    if (!id) {
      throw new Error('Could not create WhatsApp conversation');
    }

    conversation = { id, name, chatId, accountId, personId: person?.id };
  } else if (isPhoneLikeName(conversation.name) && name.trim() && !isPhoneLikeName(name)) {
    await client.mutation({
      updateWhatsappConversation: {
        __args: { id: conversation.id, data: { name: name.trim().slice(0, 120) } },
        id: true,
      },
    });
  }

  if (events.length === 0) {
    return 0;
  }

  const existing = await client.query({
    whatsappMessages: {
      __args: { filter: { externalId: { in: events.map((event) => event.eventId) } }, first: events.length },
      edges: { node: { externalId: true } },
    },
  });
  const existingIds = new Set(
    nodesOf<{ externalId: string }>(existing.whatsappMessages).map((message) => message.externalId),
  );
  const missing = events.filter((event) => !existingIds.has(event.eventId));

  if (missing.length > 0) {
    const created = await client.mutation({
      createWhatsappMessages: {
        __args: {
          data: missing.map((event) => ({
            name: event.text.slice(0, 80),
            conversationId: conversation.id,
            externalId: event.eventId,
            direction: event.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND',
            text: event.text,
            sentAt: event.sentAt,
            deliveryState: event.direction === 'outbound' ? 'SENT' : 'RECEIVED',
            ...(event.media ? { mediaKind: MEDIA_KIND_VALUES[event.media.kind] } : {}),
            ...(event.senderId ? { senderId: event.senderId } : {}),
            ...(event.senderName ? { senderName: event.senderName } : {}),
          })),
        },
        id: true,
      },
    });

    if (created.createWhatsappMessages?.length !== missing.length) {
      throw new Error('Could not create WhatsApp messages');
    }
  }

  for (const event of events.filter((item) => item.media)) {
    await attachMedia(client, event);
  }

  const latest = events.reduce((current, event) => (event.sentAt > current.sentAt ? event : current));
  const latestInbound = events
    .filter((event) => event.direction !== 'outbound')
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt))[0];
  const updateLastMessage = !conversation.lastMessageAt || latest.sentAt >= conversation.lastMessageAt;
  const updateLastInbound =
    latestInbound && (!conversation.lastInboundAt || latestInbound.sentAt >= conversation.lastInboundAt);

  if (updateLastMessage || updateLastInbound) {
    await client.mutation({
      updateWhatsappConversation: {
        __args: {
          id: conversation.id,
          data: {
            ...(updateLastMessage ? { lastMessageAt: latest.sentAt, lastPreview: latest.text.slice(0, 160) } : {}),
            ...(updateLastInbound ? { lastInboundAt: latestInbound.sentAt } : {}),
          },
        },
        id: true,
      },
    });
  }

  return missing.length;
};

// Imports the messages queued by the bridge. Direct chats need exactly one matching Person;
// group chats are imported only once an admin has imported their history (the conversation exists).
export const syncMessages = async (logger: Logger): Promise<{ imported: number; ignored: number }> => {
  const status = await getBridgeStatus();

  if (status.state !== 'connected' || !status.phoneNumber) {
    logger.info('Bridge not connected, nothing to sync', { state: status.state });
    return { imported: 0, ignored: 0 };
  }

  const client = applicationClient();
  const accountId = await ensureAccount(client, `+${digits(status.phoneNumber)}`);
  const { leaseId, events } = await bridgePost<{ leaseId?: string; events: BridgeMessageEvent[] }>('/events/claim');

  if (!leaseId) {
    return { imported: 0, ignored: 0 };
  }

  let imported = 0;
  let ignored = 0;
  let completed = false;

  try {
    // Media uploads are slow: stop the batch after the first one, the bridge asks again for the rest.
    const firstMediaIndex = events.findIndex((event) => event.media);
    const batch = firstMediaIndex < 0 ? events : events.slice(0, firstMediaIndex + 1);
    const invalid = batch.filter((event) => !isValidBridgeEvent(event));
    const eventsByChat = new Map<string, BridgeMessageEvent[]>();
    for (const event of batch.filter(isValidBridgeEvent)) {
      eventsByChat.set(event.chatId, [...(eventsByChat.get(event.chatId) ?? []), event]);
    }
    const people = await findPeopleByPhones(client, [...eventsByChat.keys()].filter(isDirectChatId).map(chatNumber));

    if (invalid.length > 0) {
      logger.warn('Dropping invalid bridge events', { count: invalid.length });
      await bridgePost('/events/ack', { eventIds: invalid.map((event) => event.eventId) });
    }

    for (const [chatId, chatEvents] of eventsByChat) {
      try {
        if (isGroupChatId(chatId)) {
          const conversation = await findConversation(client, accountId, chatId);

          if (conversation) {
            imported += await importChatMessages(client, accountId, chatId, conversation.name, chatEvents);
          } else {
            ignored += chatEvents.length;
          }
        } else {
          const matches = people.get(chatNumber(chatId)) ?? [];

          if (matches.length === 1) {
            imported += await importChatMessages(
              client,
              accountId,
              chatId,
              personName(matches[0]) || chatNumber(chatId),
              chatEvents,
              matches[0],
            );
          } else {
            ignored += chatEvents.length;
          }
        }

        await bridgePost('/events/ack', { eventIds: chatEvents.map((event) => event.eventId) });
      } catch (error) {
        // Keep the chat's events queued for the next sync and carry on with the other chats.
        logger.error('Could not import chat', {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    completed = true;
  } finally {
    await bridgePost('/events/release', { leaseId, completed }).catch(() => undefined);
  }

  logger.info('Synced messages', { imported, ignored });
  return { imported, ignored };
};

// Updates conversation names from WhatsApp contact names. Runs from the cron only.
export const syncConversationNames = async (logger: Logger): Promise<void> => {
  const client = applicationClient();
  let after: string | undefined;
  let renamed = 0;

  for (let page = 0; page < 100; page += 1) {
    const result = await client.query({
      whatsappConversations: {
        __args: { first: 100, after },
        edges: { node: { id: true, chatId: true, name: true } },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });
    const conversations = nodesOf<{ id: string; chatId: string; name: string }>(result.whatsappConversations);

    if (conversations.length > 0) {
      const names = await bridgePost<{ chatId: string; name: string }[]>('/history/names', {
        chatIds: conversations.map((conversation) => conversation.chatId),
      });
      const nameByChatId = new Map(names.map(({ chatId, name }) => [chatId, name.trim().slice(0, 120)]));

      for (const conversation of conversations) {
        const name = nameByChatId.get(conversation.chatId);

        if (name && !isPhoneLikeName(name) && name !== conversation.name) {
          await client.mutation({
            updateWhatsappConversation: { __args: { id: conversation.id, data: { name } }, id: true },
          });
          renamed += 1;
        }
      }
    }

    after = result.whatsappConversations?.pageInfo?.endCursor ?? undefined;

    if (!result.whatsappConversations?.pageInfo?.hasNextPage || !after) {
      break;
    }
  }

  logger.info('Synced conversation names', { renamed });
};
