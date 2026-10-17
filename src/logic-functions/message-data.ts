import { CoreApiClient } from 'twenty-client-sdk/core';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import { importMessageMedia } from 'src/logic-functions/message-media';
import type { Logger } from 'src/logic-functions/utils/logger';
import {
  chatNumber,
  digits,
  isChatId,
  isContactId,
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

// A contact saved in the phone's address book: the only people the app creates as People.
export type SavedContact = { phoneNumber: string; firstName: string; lastName: string };

// Creates a Person for each saved contact whose number no Person has yet, and adds them to peopleByPhone.
export const createPeopleForContacts = async (
  client: CoreApiClient,
  contacts: SavedContact[],
  peopleByPhone: Map<string, Person[]>,
): Promise<number> => {
  const missing = [...new Map(contacts.map((contact) => [digits(contact.phoneNumber), contact])).entries()].filter(
    ([number, contact]) => number && contact.firstName.trim() && !peopleByPhone.has(number),
  );

  if (missing.length === 0) {
    return 0;
  }

  const created = await client.mutation({
    createPeople: {
      __args: {
        data: missing.map(([number, { firstName, lastName }]) => ({
          name: { firstName: firstName.trim(), lastName: lastName.trim() },
          phones: {
            primaryPhoneNumber: `+${number}`,
            primaryPhoneCountryCode: '',
            primaryPhoneCallingCode: '',
            additionalPhones: null,
          },
        })),
      },
      id: true,
      name: { firstName: true, lastName: true },
      phones: { primaryPhoneNumber: true, primaryPhoneCallingCode: true },
    },
  });
  const people = (created.createPeople ?? []) as Person[];

  if (people.length !== missing.length) {
    throw new Error('Could not create People');
  }

  for (const person of people) {
    peopleByPhone.set(personPhone(person), [person]);
  }

  return people.length;
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

type StoreResult = { imported: number; lastProcessedEventId?: string; mediaUploads: number };

// Stores the events not yet in Twenty, in order, with one existence query and one bulk create.
// Media is uploaded first so it rides along in the create. Stops before a media message once the
// deadline has passed; the caller resumes after lastProcessedEventId.
export const storeMessages = async (
  client: CoreApiClient,
  conversationId: string,
  events: BridgeMessageEvent[],
  deadline = Number.POSITIVE_INFINITY,
): Promise<StoreResult> => {
  if (events.length === 0) {
    return { imported: 0, mediaUploads: 0 };
  }

  const existing = await client.query({
    whatsappMessages: {
      __args: { filter: { externalId: { in: events.map((event) => event.eventId) } }, first: events.length },
      edges: { node: { id: true, externalId: true, media: { fileId: true } } },
    },
  });
  const storedByEventId = new Map(
    nodesOf<{ id: string; externalId: string; media?: { fileId: string }[] | null }>(existing.whatsappMessages).map(
      (message) => [message.externalId, message],
    ),
  );
  const toCreate: Record<string, unknown>[] = [];
  let lastProcessedEventId: string | undefined;
  let mediaUploads = 0;

  for (const event of events) {
    const stored = storedByEventId.get(event.eventId);
    const needsMedia = Boolean(event.media) && !stored?.media?.length;

    if (needsMedia) {
      if (mediaUploads > 0 && Date.now() > deadline) break;
      mediaUploads += 1;
    }

    const file = needsMedia ? await importMessageMedia(event) : undefined;

    if (stored && file) {
      await client.mutation({
        updateWhatsappMessage: { __args: { id: stored.id, data: { media: [file] } }, id: true },
      });
    } else if (!stored) {
      toCreate.push({
        name: event.text.slice(0, 80),
        conversationId,
        externalId: event.eventId,
        direction: event.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND',
        text: event.text,
        sentAt: event.sentAt,
        deliveryState: event.direction === 'outbound' ? 'SENT' : 'RECEIVED',
        ...(event.media ? { mediaKind: MEDIA_KIND_VALUES[event.media.kind] } : {}),
        ...(file ? { media: [file] } : {}),
        ...(event.senderId ? { senderId: event.senderId } : {}),
        ...(event.senderName ? { senderName: event.senderName } : {}),
      });
    }
    lastProcessedEventId = event.eventId;
  }

  if (toCreate.length > 0) {
    const created = await client.mutation({
      createWhatsappMessages: { __args: { data: toCreate }, id: true },
    });

    if (created.createWhatsappMessages?.length !== toCreate.length) {
      throw new Error('Could not create WhatsApp messages');
    }
  }

  return { imported: toCreate.length, lastProcessedEventId, mediaUploads };
};

// Moves the conversation's last message and last inbound time forward, never backward.
export const updateConversationSummary = async (
  client: CoreApiClient,
  conversation: Pick<Conversation, 'id' | 'lastMessageAt' | 'lastInboundAt'>,
  latest: Pick<BridgeMessageEvent, 'sentAt' | 'text'> | undefined,
  latestInboundAt: string | undefined,
): Promise<void> => {
  const updateLastMessage = latest && (!conversation.lastMessageAt || latest.sentAt >= conversation.lastMessageAt);
  const updateLastInbound =
    latestInboundAt && (!conversation.lastInboundAt || latestInboundAt >= conversation.lastInboundAt);

  if (!updateLastMessage && !updateLastInbound) {
    return;
  }

  await client.mutation({
    updateWhatsappConversation: {
      __args: {
        id: conversation.id,
        data: {
          ...(updateLastMessage ? { lastMessageAt: latest.sentAt, lastPreview: latest.text.slice(0, 160) } : {}),
          ...(updateLastInbound ? { lastInboundAt: latestInboundAt } : {}),
        },
      },
      id: true,
    },
  });
};

// Returns the conversation of a chat, creating it (linked to the Person, if any) when needed.
export const ensureConversation = async (
  client: CoreApiClient,
  accountId: string,
  chatId: string,
  name: string,
  person?: Pick<Person, 'id'>,
  existing?: Conversation | null,
): Promise<Conversation> => {
  const conversation = existing === undefined ? await findConversation(client, accountId, chatId) : existing;

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

    return { id, name, chatId, accountId, personId: person?.id };
  }

  if (isPhoneLikeName(conversation.name) && name.trim() && !isPhoneLikeName(name)) {
    await client.mutation({
      updateWhatsappConversation: {
        __args: { id: conversation.id, data: { name: name.trim().slice(0, 120) } },
        id: true,
      },
    });
  }

  return conversation;
};

// Stores a batch of messages from one chat, creating the conversation when needed. Safe to retry.
export const importChatMessages = async (
  client: CoreApiClient,
  accountId: string,
  chatId: string,
  name: string,
  events: BridgeMessageEvent[],
  person?: Person,
  existingConversation?: Conversation | null,
): Promise<number> => {
  if (!isChatId(chatId) || events.some((event) => event.chatId !== chatId || !isValidBridgeEvent(event))) {
    throw new Error('Invalid bridge event');
  }

  const conversation = await ensureConversation(client, accountId, chatId, name, person, existingConversation);
  const { imported } = await storeMessages(client, conversation.id, events);

  if (events.length > 0) {
    const latest = events.reduce((current, event) => (event.sentAt > current.sentAt ? event : current));
    const latestInboundAt = events
      .filter((event) => event.direction !== 'outbound')
      .map((event) => event.sentAt)
      .sort()
      .pop();
    await updateConversationSummary(client, conversation, latest, latestInboundAt);
  }

  return imported;
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

// Names the bridge knows for a chat: the display name, and first and last names from the phone's address book.
export type ContactName = { chatId: string; name: string; firstName?: string; lastName?: string };

// Imports the messages queued by the bridge. Direct chats need exactly one matching Person, created
// when the contact is saved in the phone; group chats are imported only once an admin has imported
// their history (the conversation exists), creating People for senders saved in the phone.
export type SyncResult = { imported: number; ignored: number; acknowledged: number; remaining: boolean };

export const syncMessages = async (logger: Logger, client = applicationClient()): Promise<SyncResult> => {
  const status = await getBridgeStatus();

  if (status.state !== 'connected' || !status.phoneNumber) {
    // The bridge signals again when it reconnects.
    logger.info('Bridge not connected, nothing to sync', { state: status.state });
    return { imported: 0, ignored: 0, acknowledged: 0, remaining: false };
  }

  // Claimed before any Twenty query, so a sync with nothing to do costs no API request.
  const { leaseId, events } = await bridgePost<{ leaseId?: string; events: BridgeMessageEvent[] }>('/events/claim');

  // Nothing queued, or another sync holds the batch and will queue the next one itself.
  if (!leaseId) {
    return { imported: 0, ignored: 0, acknowledged: 0, remaining: false };
  }

  let imported = 0;
  let ignored = 0;
  let acknowledged = 0;
  let createdPeople = 0;
  let remaining: boolean;
  let completed = false;

  try {
    const accountId = await ensureAccount(client, `+${digits(status.phoneNumber)}`);
    // Media uploads are slow: stop the batch after the first one, the bridge asks again for the rest.
    const firstMediaIndex = events.findIndex((event) => event.media);
    const batch = firstMediaIndex < 0 ? events : events.slice(0, firstMediaIndex + 1);
    const invalid = batch.filter((event) => !isValidBridgeEvent(event));
    const eventsByChat = new Map<string, BridgeMessageEvent[]>();
    for (const event of batch.filter(isValidBridgeEvent)) {
      eventsByChat.set(event.chatId, [...(eventsByChat.get(event.chatId) ?? []), event]);
    }
    const chatIds = [...eventsByChat.keys()];
    const groupSenderIds = [
      ...new Set(
        batch.flatMap((event) => (isGroupChatId(event.chatId) && isContactId(event.senderId) ? [event.senderId] : [])),
      ),
    ];
    // Best effort: a group's messages are imported even when its senders cannot become People.
    const savedSenders =
      groupSenderIds.length > 0
        ? await bridgePost<(SavedContact & { id: string })[]>('/contacts/saved', { ids: groupSenderIds }).catch(
            (error: unknown) => {
              logger.warn('Could not look up saved group senders', {
                error: error instanceof Error ? error.message : String(error),
              });
              return [];
            },
          )
        : [];
    const savedSenderById = new Map(savedSenders.map((sender) => [sender.id, sender]));
    const [people, conversations] = await Promise.all([
      findPeopleByPhones(client, [
        ...chatIds.filter(isDirectChatId).map(chatNumber),
        ...savedSenders.map((sender) => digits(sender.phoneNumber)),
      ]),
      findConversations(client, accountId, chatIds),
    ]);
    // New direct chats need the contact's saved name; conversations still named after a number need a better one.
    const chatsToName = chatIds.filter((chatId) => {
      const conversation = conversations.get(chatId);
      return conversation ? isPhoneLikeName(conversation.name) : isDirectChatId(chatId);
    });
    const contactByChatId = new Map(
      chatsToName.length > 0
        ? (await bridgePost<ContactName[]>('/history/names', { chatIds: chatsToName }, 30_000)).map((contact) => [
            contact.chatId,
            contact,
          ])
        : [],
    );

    if (invalid.length > 0) {
      logger.warn('Dropping invalid bridge events', { count: invalid.length });
      await bridgePost('/events/ack', { eventIds: invalid.map((event) => event.eventId) });
      acknowledged += invalid.length;
    }

    for (const [chatId, chatEvents] of eventsByChat) {
      try {
        const conversation = conversations.get(chatId) ?? null;
        const contact = contactByChatId.get(chatId);

        if (isGroupChatId(chatId)) {
          if (conversation) {
            const senders = chatEvents.flatMap((event) => savedSenderById.get(event.senderId ?? '') ?? []);
            createdPeople += await createPeopleForContacts(client, senders, people).catch((error: unknown) => {
              logger.warn('Could not create People for group senders', {
                chatId,
                error: error instanceof Error ? error.message : String(error),
              });
              return 0;
            });
            imported += await importChatMessages(
              client,
              accountId,
              chatId,
              contact?.name ?? conversation.name,
              chatEvents,
              undefined,
              conversation,
            );
          } else {
            ignored += chatEvents.length;
          }
        } else {
          // Only contacts saved in the phone become People; other unknown numbers are ignored.
          if (!people.has(chatNumber(chatId)) && contact?.firstName) {
            createdPeople += await createPeopleForContacts(
              client,
              [{ phoneNumber: chatNumber(chatId), firstName: contact.firstName, lastName: contact.lastName ?? '' }],
              people,
            );
          }
          const matches = people.get(chatNumber(chatId)) ?? [];

          if (matches.length === 1) {
            imported += await importChatMessages(
              client,
              accountId,
              chatId,
              personName(matches[0]) || contact?.name || chatNumber(chatId),
              chatEvents,
              matches[0],
              conversation,
            );
          } else {
            ignored += chatEvents.length;
          }
        }

        await bridgePost('/events/ack', { eventIds: chatEvents.map((event) => event.eventId) });
        acknowledged += chatEvents.length;
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
    // `completed` is read by bridges from before `remaining` was returned.
    const released = await bridgePost<{ remaining?: boolean }>('/events/release', { leaseId, completed }).catch(
      () => undefined,
    );
    remaining = released?.remaining ?? true;
  }

  logger.info('Synced messages', { imported, ignored, createdPeople, remaining });
  return { imported, ignored, acknowledged, remaining };
};

// Updates conversation names from WhatsApp contact names, when the bridge signals name changes.
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
