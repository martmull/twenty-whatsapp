import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgeJsonRequest, bridgeRequest } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import {
  applicationClient,
  ensureAccount,
  findPeopleByPhone,
  importHistoryMessagesForPerson,
  userClient,
  type BridgeMessageEvent,
  type Person,
} from 'src/logic-functions/message-data';

type HistoryRequest = {
  action?: 'list' | 'import';
  rangeDays?: 0 | 30 | 90;
  offset?: number;
  chatId?: string;
  createPerson?: boolean;
  acknowledged?: boolean;
};

type HistoryCandidate = {
  chatId: string;
  name: string;
  messageCount: number;
  lastMessageAt?: string;
};

type HistoryList = {
  items: HistoryCandidate[];
  total: number;
  historyReceivedAt?: string;
};

type HistoryMessages = {
  name: string;
  messages: BridgeMessageEvent[];
  total: number;
  nextOffset?: number;
};

const handler = async (event: RoutePayload<HistoryRequest>) => {
  if (!event.userWorkspaceId || !(await canManageConnection())) {
    throw new Error('Only workspace administrators can import WhatsApp history');
  }

  const request = event.body;

  if (!request || (request.rangeDays !== 0 && request.rangeDays !== 30 && request.rangeDays !== 90)) {
    throw new Error('Invalid history range');
  }

  const status = await bridgeRequest('/status');

  if (status.state !== 'connected' || !status.phoneNumber) {
    throw new Error('WhatsApp is disconnected');
  }

  const client = applicationClient();

  if (request.action === 'list') {
    const offset = request.offset ?? 0;

    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
      throw new Error('Invalid history offset');
    }

    const history = await bridgeJsonRequest<HistoryList>('/history/list', { rangeDays: request.rangeDays, offset, limit: 20 });
    const peopleByPhone = await findPeopleByPhone(client);

    return {
      ...history,
      items: history.items.map((item) => {
        const matches = peopleByPhone.get(item.chatId.split('@')[0]) ?? [];
        return {
          ...item,
          match: matches.length === 1 ? 'matched' as const : matches.length > 1 ? 'ambiguous' as const : 'new' as const,
          personName: matches.length === 1 ? [matches[0].name.firstName, matches[0].name.lastName].filter(Boolean).join(' ') : undefined,
        };
      }),
    };
  }

  if (request.action !== 'import' || !request.chatId || !/^\d{7,15}@s\.whatsapp\.net$/.test(request.chatId) || !Number.isInteger(request.offset) || (request.offset ?? -1) < 0 || request.acknowledged !== true) {
    throw new Error('Invalid history import request');
  }

  if (request.chatId.split('@')[0] === status.phoneNumber.replace(/\D/g, '')) {
    throw new Error('Cannot import the linked account as a contact');
  }

  const history = await bridgeJsonRequest<HistoryMessages>('/history/messages', {
    chatId: request.chatId,
    rangeDays: request.rangeDays,
    offset: request.offset,
    limit: 25,
  });
  const peopleByPhone = await findPeopleByPhone(client);
  const matches = peopleByPhone.get(request.chatId.split('@')[0]) ?? [];

  if (matches.length > 1) {
    throw new Error('More than one Person has this phone number');
  }

  let person: Person | undefined = matches[0];
  let createdPerson = false;

  if (!person) {
    if (request.createPerson !== true) {
      throw new Error('This contact is not matched to a Person');
    }

    const name = history.name.trim();
    const [firstName, ...lastName] = name.split(/\s+/);
    const created = await userClient().mutation({
      createPerson: {
        __args: {
          data: {
            name: { firstName: firstName || `+${request.chatId.split('@')[0]}`, lastName: lastName.join(' ') },
            phones: {
              primaryPhoneNumber: `+${request.chatId.split('@')[0]}`,
              primaryPhoneCountryCode: '',
              primaryPhoneCallingCode: '',
              additionalPhones: null,
            },
          },
        },
        id: true,
      },
    });
    const id = created.createPerson?.id;

    if (!id) {
      throw new Error('Could not create Person');
    }

    person = { id, name: { firstName, lastName: lastName.join(' ') } };
    createdPerson = true;
  }

  const accountId = await ensureAccount(client, `+${status.phoneNumber.replace(/\D/g, '')}`);
  for (const message of history.messages) {
    if (message.chatId !== request.chatId) {
      throw new Error('History message belongs to another chat');
    }
  }

  const imported = await importHistoryMessagesForPerson(client, accountId, history.messages, person);

  return { imported, total: history.total, nextOffset: history.nextOffset, createdPerson };
};

export default defineLogicFunction({
  universalIdentifier: '6e6ef756-2022-4d4d-93af-3f1a95fe5a86',
  name: 'whatsapp-history',
  description: 'Review and selectively import available WhatsApp history.',
  timeoutSeconds: 120,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/history',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
