import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import {
  applicationClient,
  ensureAccount,
  findPeopleByPhone,
  importHistoryMessagesForPerson,
  importHistoryMessages,
  userClient,
  type BridgeMessageEvent,
  type Person,
} from 'src/logic-functions/message-data';

type HistoryRequest = {
  action?: 'list' | 'import' | 'members';
  rangeDays?: 0 | 30 | 90;
  kind?: 'all' | 'direct' | 'group';
  offset?: number;
  chatId?: string;
  createPerson?: boolean;
  acknowledged?: boolean;
  firstName?: string;
  lastName?: string;
};

type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  messageCount: number;
  lastMessageAt?: string;
};

const isPhoneName = (name: string) => /^\+?\d+$/.test(name.trim());

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

type GroupMember = {
  id: string;
  phoneNumber?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
};

const handler = async (event: RoutePayload<HistoryRequest>) => {
  if (!event.userWorkspaceId || !(await canManageConnection())) {
    throw new Error('Only workspace administrators can import WhatsApp history');
  }

  const request = event.body;

  if (!request || (request.rangeDays !== 0 && request.rangeDays !== 30 && request.rangeDays !== 90)) {
    throw new Error('Invalid history range');
  }

  const status = await getBridgeStatus();

  if (status.state !== 'connected' || !status.phoneNumber) {
    throw new Error('WhatsApp is disconnected');
  }

  if (request.action === 'members') {
    if (!/^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(request.chatId ?? '')) {
      throw new Error('Invalid group ID');
    }
    return bridgePost<GroupMember[]>('/history/members', { chatId: request.chatId });
  }

  const client = applicationClient();

  if (request.action === 'list') {
    const offset = request.offset ?? 0;

    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
      throw new Error('Invalid history offset');
    }

    const kind = request.kind ?? 'all';
    if (kind !== 'all' && kind !== 'direct' && kind !== 'group') {
      throw new Error('Invalid history kind');
    }
    const history = await bridgePost<HistoryList>('/history/list', { rangeDays: request.rangeDays, kind, offset, limit: 20 }, 30_000);
    const peopleByPhone = await findPeopleByPhone(client);

    return {
      ...history,
      items: history.items.map((item) => {
        if (item.kind === 'group') {
          return { ...item, match: 'group' as const };
        }
        const matches = peopleByPhone.get(item.chatId.split('@')[0]) ?? [];
        const personName = matches.length === 1 ? [matches[0].name.firstName, matches[0].name.lastName].filter(Boolean).join(' ') : undefined;
        const renameable = matches.length === 1 && isPhoneName(personName || '') && personName?.replace(/\D/g, '') === item.chatId.split('@')[0];
        return {
          ...item,
          name: renameable ? item.name : personName || item.name,
          match: matches.length === 1 ? 'matched' as const : matches.length > 1 ? 'ambiguous' as const : 'new' as const,
          personName,
          renameable,
        };
      }),
    };
  }

  const isGroup = /^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(request.chatId ?? '');
  if (request.action !== 'import' || !request.chatId || (!/^\d{7,15}@s\.whatsapp\.net$/.test(request.chatId) && !isGroup) || !Number.isInteger(request.offset) || (request.offset ?? -1) < 0 || request.acknowledged !== true) {
    throw new Error('Invalid history import request');
  }

  if (!isGroup && request.chatId.split('@')[0] === status.phoneNumber.replace(/\D/g, '')) {
    throw new Error('Cannot import the linked account as a contact');
  }

  const history = await bridgePost<HistoryMessages>('/history/messages', {
    chatId: request.chatId,
    rangeDays: request.rangeDays,
    offset: request.offset,
    limit: 25,
  }, 30_000);
  const accountId = await ensureAccount(client, `+${status.phoneNumber.replace(/\D/g, '')}`);
  for (const message of history.messages) {
    if (message.chatId !== request.chatId) {
      throw new Error('History message belongs to another chat');
    }
  }

  if (isGroup) {
    const imported = await importHistoryMessages(client, accountId, request.chatId, history.name.slice(0, 120), history.messages);
    return { imported, total: history.total, nextOffset: history.nextOffset, createdPerson: false };
  }

  const peopleByPhone = await findPeopleByPhone(client);
  const matches = peopleByPhone.get(request.chatId.split('@')[0]) ?? [];

  if (matches.length > 1) {
    throw new Error('More than one Person has this phone number');
  }

  let person: Person | undefined = matches[0];
  let createdPerson = false;

  if ((request.firstName && (request.firstName.length > 80 || !request.firstName.trim())) || (request.lastName && (request.lastName.length > 80 || !request.lastName.trim()))) {
    throw new Error('Invalid Person name');
  }

  const [suggestedFirstName, ...suggestedLastName] = isPhoneName(history.name) ? ['', ''] : history.name.trim().split(/\s+/);
  const firstName = request.firstName?.trim() || suggestedFirstName;
  const lastName = request.lastName?.trim() || suggestedLastName.join(' ');

  if (!person) {
    if (request.createPerson !== true) {
      throw new Error('This contact is not matched to a Person');
    }

    if (!firstName) {
      throw new Error('Enter a first name for this contact before importing');
    }
    const created = await userClient().mutation({
      createPerson: {
        __args: {
          data: {
            name: { firstName, lastName },
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

    person = { id, name: { firstName, lastName } };
    createdPerson = true;
  } else if (isPhoneName([person.name.firstName, person.name.lastName].filter(Boolean).join(' ')) && firstName) {
    await userClient().mutation({
      updatePerson: {
        __args: { id: person.id, data: { name: { firstName, lastName } } },
        id: true,
      },
    });
    person = { ...person, name: { firstName, lastName } };
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
