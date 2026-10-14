import { CoreApiClient } from 'twenty-client-sdk/core';

import { bridgeJsonRequest, bridgeRequest } from 'src/logic-functions/bridge-request';

export type Conversation = {
  id: string;
  name: string;
  chatId: string;
  personId: string;
  accountId: string;
  lastMessageAt?: string | null;
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

const findConversation = async (client: CoreApiClient, accountId: string, chatId: string): Promise<Conversation | undefined> => {
  const result = await client.query({
    whatsappConversations: {
      __args: { filter: { accountId: { eq: accountId }, chatId: { eq: chatId } }, first: 1 },
      edges: { node: { id: true, name: true, chatId: true, personId: true, accountId: true, lastMessageAt: true, lastPreview: true } },
    },
  });

  return result.whatsappConversations?.edges?.[0]?.node as Conversation | undefined;
};

const findMessageByExternalId = async (client: CoreApiClient, externalId: string): Promise<Message | undefined> => {
  const result = await client.query({
    whatsappMessages: {
      __args: { filter: { externalId: { eq: externalId } }, first: 1 },
      edges: { node: { id: true, conversationId: true, externalId: true, direction: true, text: true, sentAt: true, deliveryState: true, requestId: true } },
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
    await client.mutation({
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
          },
        },
        id: true,
      },
    });
  }

  if (!conversation.lastMessageAt || event.sentAt >= conversation.lastMessageAt) {
    await client.mutation({
      updateWhatsappConversation: {
        __args: { id: conversation.id, data: { lastMessageAt: event.sentAt, lastPreview: event.text.slice(0, 160) } },
        id: true,
      },
    });
    conversation.lastMessageAt = event.sentAt;
  }

  return !existing;
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

export const syncMessages = async (): Promise<{ imported: number; ignored: number }> => {
  const status = await bridgeRequest('/status');
  const phoneNumber = status.phoneNumber ? `+${digits(status.phoneNumber)}` : undefined;

  if (!phoneNumber || status.state !== 'connected') {
    return { imported: 0, ignored: 0 };
  }

  const client = applicationClient();
  const accountId = await ensureAccount(client, phoneNumber);

  const events = await bridgeJsonRequest<BridgeMessageEvent[]>('/events');

  if (events.length === 0) {
    return { imported: 0, ignored: 0 };
  }

  const peopleByPhone = await findPeopleByPhone(client);

  let imported = 0;
  let ignored = 0;

  for (const event of events) {
    if (!/^[a-f\d]{64}$/.test(event.eventId) || !/^\d{7,15}@s\.whatsapp\.net$/.test(event.chatId) || !event.text || event.text.length > 4096 || (event.direction && event.direction !== 'inbound' && event.direction !== 'outbound')) {
      throw new Error('Invalid bridge event');
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

  return { imported, ignored };
};
