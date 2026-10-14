import { CoreApiClient } from 'twenty-client-sdk/core';

import { bridgeJsonRequest, bridgeRequest } from 'src/logic-functions/bridge-request';
import { importMessageMedia } from 'src/logic-functions/message-media';

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
  direction: string;
  text: string;
  sentAt: string;
  deliveryState: string;
  requestId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  mediaKind?: string | null;
  media?: { fileId: string; label?: string | null; url?: string | null }[] | null;
};

export type Person = {
  id: string;
  name: { firstName?: string | null; lastName?: string | null };
  phones?: { primaryPhoneNumber?: string | null; primaryPhoneCallingCode?: string | null } | null;
};

export type BridgeMessageEvent = {
  eventId: string;
  chatId: string;
  providerMessageId: string;
  direction?: 'inbound' | 'outbound';
  text: string;
  sentAt: string;
  senderId?: string;
  senderName?: string;
  media?: { kind: 'image' | 'video'; mimeType: string; fileName: string; sizeBytes?: number };
};

export const applicationClient = () => new CoreApiClient({ runAs: 'application' });
export const userClient = () => new CoreApiClient({ runAs: 'user' });

const digits = (value: string) => value.replace(/\D/g, '');

const personPhone = (person: Person): string => {
  const phone = person.phones?.primaryPhoneNumber ?? '';
  const callingCode = person.phones?.primaryPhoneCallingCode ?? '';

  if (phone.startsWith('+') || !callingCode) {
    return digits(phone);
  }

  return digits(callingCode) + digits(phone).replace(/^0/, '');
};

export const findPeopleByPhone = async (client: CoreApiClient): Promise<Map<string, Person[]>> => {
  const peopleByPhone = new Map<string, Person[]>();
  let after: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await client.query({
      people: {
        __args: { first: 100, after },
        edges: { node: { id: true, name: { firstName: true, lastName: true }, phones: { primaryPhoneNumber: true, primaryPhoneCallingCode: true } } },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });
    const connection = result.people as { edges?: { node: Person }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | undefined;

    for (const { node } of connection?.edges ?? []) {
      const number = personPhone(node);

      if (number) {
        peopleByPhone.set(number, [...(peopleByPhone.get(number) ?? []), node]);
      }
    }

    if (!connection?.pageInfo?.hasNextPage) {
      return peopleByPhone;
    }

    after = connection.pageInfo.endCursor ?? undefined;

    if (!after) {
      throw new Error('Person pagination stopped unexpectedly');
    }
  }

  throw new Error('Person match limit reached');
};

const findAccount = async (client: CoreApiClient, phoneNumber: string): Promise<{ id: string; state: string } | undefined> => {
  const result = await client.query({
    whatsappAccounts: {
      __args: { filter: { phoneNumber: { eq: phoneNumber } }, first: 1 },
      edges: { node: { id: true, state: true } },
    },
  });

  return result.whatsappAccounts?.edges?.[0]?.node as { id: string; state: string } | undefined;
};

export const findConversation = async (client: CoreApiClient, accountId: string, chatId: string): Promise<Conversation | undefined> => {
  const result = await client.query({
    whatsappConversations: {
      __args: { filter: { accountId: { eq: accountId }, chatId: { eq: chatId } }, first: 1 },
      edges: { node: { id: true, name: true, chatId: true, personId: true, accountId: true, lastMessageAt: true, lastInboundAt: true, lastPreview: true } },
    },
  });

  return result.whatsappConversations?.edges?.[0]?.node as Conversation | undefined;
};

const findMessageByExternalId = async (client: CoreApiClient, externalId: string): Promise<Message | undefined> => {
  const result = await client.query({
    whatsappMessages: {
      __args: { filter: { externalId: { eq: externalId } }, first: 1 },
      edges: { node: { id: true, conversationId: true, externalId: true, direction: true, text: true, sentAt: true, deliveryState: true, requestId: true, mediaKind: true, media: { fileId: true } } },
    },
  });

  return result.whatsappMessages?.edges?.[0]?.node as Message | undefined;
};

export const ensureAccount = async (client: CoreApiClient, phoneNumber: string): Promise<string> => {
  const account = await findAccount(client, phoneNumber);
  let accountId = account?.id;

  if (!accountId) {
    const created = await client.mutation({
      createWhatsappAccount: { __args: { data: { name: phoneNumber, phoneNumber, state: 'connected' } }, id: true },
    });
    accountId = created.createWhatsappAccount?.id;
  } else if (account?.state !== 'connected') {
    await client.mutation({
      updateWhatsappAccount: { __args: { id: accountId, data: { state: 'connected' } }, id: true },
    });
  }

  if (!accountId) {
    throw new Error('Could not create WhatsApp account');
  }

  return accountId;
};

const attachMedia = async (client: CoreApiClient, event: BridgeMessageEvent, message: Message): Promise<void> => {
  if (!event.media) {
    return;
  }

  if (message.mediaKind !== event.media.kind) {
    await client.mutation({
      updateWhatsappMessage: {
        __args: { id: message.id, data: { mediaKind: event.media.kind } },
        id: true,
      },
    });
  }
  if (message.media?.length) {
    return;
  }

  const file = await importMessageMedia(event);
  if (!file) {
    return;
  }

  await client.mutation({
    updateWhatsappMessage: {
      __args: { id: message.id, data: { media: [file] } },
      id: true,
    },
  });
};

export const importMessageForPerson = async (client: CoreApiClient, accountId: string, event: BridgeMessageEvent, person: Person): Promise<boolean> => {
  if (!/^[a-f\d]{64}$/.test(event.eventId) || !/^\d{7,15}@s\.whatsapp\.net$/.test(event.chatId) || !event.text || event.text.length > 4096 || (event.direction && event.direction !== 'inbound' && event.direction !== 'outbound') || !Number.isFinite(Date.parse(event.sentAt))) {
    throw new Error('Invalid bridge event');
  }

  let conversation = await findConversation(client, accountId, event.chatId);

  if (!conversation) {
    const name = [person.name.firstName, person.name.lastName].filter(Boolean).join(' ') || event.chatId.split('@')[0];
    const created = await client.mutation({
      createWhatsappConversation: {
        __args: { data: { name, chatId: event.chatId, personId: person.id, linkedPersonId: person.id, accountId } },
        id: true,
      },
    });
    const id = created.createWhatsappConversation?.id;

    if (!id) {
      throw new Error('Could not create WhatsApp conversation');
    }

    conversation = { id, name, chatId: event.chatId, personId: person.id, accountId };
  }

  const existing = await findMessageByExternalId(client, event.eventId);

  if (!existing) {
    const created = await client.mutation({
      createWhatsappMessage: {
        __args: {
          data: {
            name: event.text.slice(0, 80),
            conversationId: conversation.id,
            externalId: event.eventId,
            direction: event.direction ?? 'inbound',
            text: event.text,
            sentAt: event.sentAt,
            deliveryState: event.direction === 'outbound' ? 'sent' : 'received',
            ...(event.media ? { mediaKind: event.media.kind } : {}),
          },
        },
        id: true,
      },
    });
    if (!created.createWhatsappMessage?.id) {
      throw new Error('Could not create WhatsApp message');
    }
  }

  if (event.media) {
    const message = existing ?? await findMessageByExternalId(client, event.eventId);
    if (!message) {
      throw new Error('Could not find imported WhatsApp message');
    }
    await attachMedia(client, event, message);
  }

  const updateLastMessage = !conversation.lastMessageAt || event.sentAt >= conversation.lastMessageAt;
  const updateLastInbound = event.direction !== 'outbound' && (!conversation.lastInboundAt || event.sentAt >= conversation.lastInboundAt);

  if (updateLastMessage || updateLastInbound) {
    await client.mutation({
      updateWhatsappConversation: {
        __args: { id: conversation.id, data: {
          ...(updateLastMessage ? { lastMessageAt: event.sentAt, lastPreview: event.text.slice(0, 160) } : {}),
          ...(updateLastInbound ? { lastInboundAt: event.sentAt } : {}),
        } },
        id: true,
      },
    });
    if (updateLastMessage) conversation.lastMessageAt = event.sentAt;
    if (updateLastInbound) conversation.lastInboundAt = event.sentAt;
  }

  return !existing;
};

export const importHistoryMessages = async (client: CoreApiClient, accountId: string, chatId: string, name: string, events: BridgeMessageEvent[], person?: Person): Promise<number> => {
  if (!/^\d{7,15}@s\.whatsapp\.net$/.test(chatId) && !/^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(chatId)) {
    throw new Error('Invalid chat ID');
  }

  for (const event of events) {
    if (event.chatId !== chatId || !/^[a-f\d]{64}$/.test(event.eventId) || !event.text || event.text.length > 4096 || (event.direction && event.direction !== 'inbound' && event.direction !== 'outbound') || !Number.isFinite(Date.parse(event.sentAt))) {
      throw new Error('Invalid bridge event');
    }
  }

  let conversation = await findConversation(client, accountId, chatId);

  if (!conversation) {
    const created = await client.mutation({
      createWhatsappConversation: {
        __args: { data: { name, chatId, ...(person ? { personId: person.id, linkedPersonId: person.id } : {}), accountId } },
        id: true,
      },
    });
    const id = created.createWhatsappConversation?.id;

    if (!id) {
      throw new Error('Could not create WhatsApp conversation');
    }

    conversation = { id, name, chatId, personId: person?.id, accountId };
  } else if (/^\+?\d+$/.test(conversation.name) && name.trim() && !/^\+?\d+$/.test(name.trim())) {
    await client.mutation({
      updateWhatsappConversation: {
        __args: { id: conversation.id, data: { name: name.trim().slice(0, 120) } },
        id: true,
      },
    });
    conversation.name = name.trim().slice(0, 120);
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

  if (!existing.whatsappMessages) {
    throw new Error('Could not check existing WhatsApp messages');
  }

  const existingIds = new Set(existing.whatsappMessages.edges.map(({ node }) => node.externalId));
  const missing = events.filter((event) => !existingIds.has(event.eventId));

  if (missing.length > 0) {
    const created = await client.mutation({
      createWhatsappMessages: {
        __args: { data: missing.map((event) => ({
          name: event.text.slice(0, 80),
          conversationId: conversation.id,
          externalId: event.eventId,
          direction: event.direction ?? 'inbound',
          text: event.text,
          sentAt: event.sentAt,
          deliveryState: event.direction === 'outbound' ? 'sent' : 'received',
          ...(event.media ? { mediaKind: event.media.kind } : {}),
          ...(event.senderId ? { senderId: event.senderId } : {}),
          ...(event.senderName ? { senderName: event.senderName } : {}),
        })) },
        id: true,
      },
    });

    if (created.createWhatsappMessages?.length !== missing.length) {
      throw new Error('Could not create WhatsApp messages');
    }
  }

  for (const event of events) {
    if (!event.media) {
      continue;
    }
    const message = await findMessageByExternalId(client, event.eventId);
    if (!message) {
      throw new Error('Could not find imported WhatsApp message');
    }
    await attachMedia(client, event, message);
  }

  const latest = events.reduce((current, event) => event.sentAt > current.sentAt ? event : current);
  const latestInbound = events.filter((event) => event.direction !== 'outbound').reduce<BridgeMessageEvent | undefined>((current, event) => !current || event.sentAt > current.sentAt ? event : current, undefined);
  const updateLastMessage = !conversation.lastMessageAt || latest.sentAt >= conversation.lastMessageAt;
  const updateLastInbound = latestInbound && (!conversation.lastInboundAt || latestInbound.sentAt >= conversation.lastInboundAt);

  if (updateLastMessage || updateLastInbound) {
    await client.mutation({
      updateWhatsappConversation: {
        __args: { id: conversation.id, data: {
          ...(updateLastMessage ? { lastMessageAt: latest.sentAt, lastPreview: latest.text.slice(0, 160) } : {}),
          ...(updateLastInbound ? { lastInboundAt: latestInbound.sentAt } : {}),
        } },
        id: true,
      },
    });
  }

  return missing.length;
};

export const importHistoryMessagesForPerson = async (client: CoreApiClient, accountId: string, events: BridgeMessageEvent[], person: Person): Promise<number> => {
  if (events.length === 0) {
    return 0;
  }

  const name = [person.name.firstName, person.name.lastName].filter(Boolean).join(' ') || events[0].chatId.split('@')[0];
  return importHistoryMessages(client, accountId, events[0].chatId, name, events, person);
};

export const findMessageByRequestId = async (client: CoreApiClient, requestId: string): Promise<Message | undefined> => {
  const result = await client.query({
    whatsappMessages: {
      __args: { filter: { requestId: { eq: requestId } }, first: 1 },
      edges: { node: { id: true, conversationId: true, externalId: true, direction: true, text: true, sentAt: true, deliveryState: true, requestId: true } },
    },
  });

  return result.whatsappMessages?.edges?.[0]?.node as Message | undefined;
};

const syncConversationNames = async (client: CoreApiClient, accountId: string): Promise<void> => {
  let after: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = await client.query({
      whatsappConversations: {
        __args: { filter: { accountId: { eq: accountId } }, first: 100, after },
        edges: { node: { id: true, chatId: true, name: true } },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });
    const connection = result.whatsappConversations;
    const conversations = (connection?.edges ?? []).map(({ node }) => node);
    if (conversations.length > 0) {
      const names = await bridgeJsonRequest<{ chatId: string; name: string }[]>('/history/names', {
        chatIds: conversations.map((conversation) => conversation.chatId).filter((chatId): chatId is string => typeof chatId === 'string'),
      });
      const nameByChatId = new Map(names.map(({ chatId, name }) => [chatId, name]));

      for (const conversation of conversations) {
        if (!conversation.chatId) {
          continue;
        }
        const name = nameByChatId.get(conversation.chatId)?.trim().slice(0, 120);
        if (name && !/^\+?\d+$/.test(name) && name !== conversation.name) {
          await client.mutation({
            updateWhatsappConversation: {
              __args: { id: conversation.id, data: { name } },
              id: true,
            },
          });
        }
      }
    }

    if (!connection?.pageInfo?.hasNextPage) {
      return;
    }
    after = connection.pageInfo.endCursor ?? undefined;
    if (!after) {
      throw new Error('Conversation pagination stopped unexpectedly');
    }
  }

  throw new Error('Conversation name sync limit reached');
};

export const syncMessages = async (): Promise<{ imported: number; ignored: number }> => {
  const status = await bridgeRequest('/status');
  const phoneNumber = status.phoneNumber ? `+${digits(status.phoneNumber)}` : undefined;

  if (!phoneNumber || status.state !== 'connected') {
    return { imported: 0, ignored: 0 };
  }

  const client = applicationClient();
  const accountId = await ensureAccount(client, phoneNumber);

  const { leaseId, events } = await bridgeJsonRequest<{ leaseId?: string; events: BridgeMessageEvent[] }>('/events/claim');

  if (!leaseId || events.length === 0) {
    await syncConversationNames(client, accountId).catch(() => undefined);
    return { imported: 0, ignored: 0 };
  }

  let completed = false;
  let imported = 0;
  let ignored = 0;
  try {
    const peopleByPhone = await findPeopleByPhone(client);

    const firstMediaIndex = events.findIndex((event) => event.media);
    for (const event of firstMediaIndex < 0 ? events : events.slice(0, firstMediaIndex + 1)) {
      const isGroup = /^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(event.chatId);
      if (!/^[a-f\d]{64}$/.test(event.eventId) || (!/^\d{7,15}@s\.whatsapp\.net$/.test(event.chatId) && !isGroup) || !event.text || event.text.length > 4096 || (event.direction && event.direction !== 'inbound' && event.direction !== 'outbound')) {
        throw new Error('Invalid bridge event');
      }

      if (isGroup) {
        const conversation = await findConversation(client, accountId, event.chatId);

        if (conversation) {
          imported += await importHistoryMessages(client, accountId, event.chatId, conversation.name, [event]);
        } else {
          ignored += 1;
        }

        await bridgeJsonRequest('/events/ack', { eventIds: [event.eventId] });
        continue;
      }

      const candidates = peopleByPhone.get(event.chatId.split('@')[0]) ?? [];

      if (candidates.length !== 1) {
        ignored += 1;
        await bridgeJsonRequest('/events/ack', { eventIds: [event.eventId] });
        continue;
      }

      if (await importMessageForPerson(client, accountId, event, candidates[0])) {
        imported += 1;
      }

      await bridgeJsonRequest('/events/ack', { eventIds: [event.eventId] });
    }

    completed = true;
  } finally {
    await bridgeJsonRequest('/events/release', { leaseId, completed }).catch(() => undefined);
  }
  await syncConversationNames(client, accountId).catch(() => undefined);
  return { imported, ignored };
};
