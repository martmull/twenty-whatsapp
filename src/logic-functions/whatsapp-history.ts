import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import {
  applicationClient,
  ensureAccount,
  findPeopleByPhones,
  importChatMessages,
  personName,
  userClient,
  type BridgeMessageEvent,
  type Person,
} from 'src/logic-functions/message-data';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { chatNumber, digits, isChatId, isGroupChatId, isPhoneLikeName } from 'src/logic-functions/utils/validators';

type HistoryRequest = {
  action?: 'list' | 'import' | 'members';
  rangeDays?: 0 | 30 | 90;
  kind?: 'all' | 'direct' | 'group';
  offset?: number;
  chatId?: string;
  createPerson?: boolean;
  firstName?: string;
  lastName?: string;
};

type HistoryCandidate = { chatId: string; kind: 'direct' | 'group'; name: string; messageCount: number; lastMessageAt?: string };
type HistoryMessages = { name: string; messages: BridgeMessageEvent[]; total: number; nextOffset?: number };

const listCandidates = async (request: HistoryRequest) => {
  const offset = request.offset ?? 0;
  const kind = request.kind ?? 'all';

  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000 || !['all', 'direct', 'group'].includes(kind)) {
    throw new HttpError(400, 'Invalid history request');
  }

  const history = await bridgePost<{ items: HistoryCandidate[]; total: number; historyReceivedAt?: string }>(
    '/history/list', { rangeDays: request.rangeDays, kind, offset, limit: 20 }, 30_000);
  const directNumbers = history.items.filter((item) => item.kind === 'direct').map((item) => chatNumber(item.chatId));
  const peopleByPhone = await findPeopleByPhones(applicationClient(), directNumbers);

  return {
    ...history,
    items: history.items.map((item) => {
      if (item.kind === 'group') {
        return { ...item, match: 'group' as const };
      }

      const matches = peopleByPhone.get(chatNumber(item.chatId)) ?? [];
      const matchedName = matches.length === 1 ? personName(matches[0]) : undefined;
      // A Person named after their phone number can be renamed during import.
      const renameable = matches.length === 1 && isPhoneLikeName(matchedName || '') && digits(matchedName || '') === chatNumber(item.chatId);

      return {
        ...item,
        name: renameable ? item.name : matchedName || item.name,
        match: matches.length === 1 ? 'matched' as const : matches.length > 1 ? 'ambiguous' as const : 'new' as const,
        personName: matchedName,
        renameable,
      };
    }),
  };
};

// Finds the Person for a direct chat, creating or renaming them as the admin asked.
const resolvePerson = async (request: HistoryRequest, chatId: string, historyName: string): Promise<{ person: Person; createdPerson: boolean }> => {
  const matches = (await findPeopleByPhones(applicationClient(), [chatNumber(chatId)])).get(chatNumber(chatId)) ?? [];

  if (matches.length > 1) {
    throw new HttpError(409, 'More than one Person has this phone number');
  }

  for (const value of [request.firstName, request.lastName]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 80 || !value.trim())) {
      throw new HttpError(400, 'Invalid Person name');
    }
  }

  const [suggestedFirstName = '', ...suggestedLastName] = isPhoneLikeName(historyName) ? [] : historyName.trim().split(/\s+/);
  const firstName = request.firstName?.trim() || suggestedFirstName;
  const lastName = request.lastName?.trim() || suggestedLastName.join(' ');
  const existing = matches[0];

  if (!existing) {
    if (request.createPerson !== true) throw new HttpError(409, 'This contact is not matched to a Person');
    if (!firstName) throw new HttpError(400, 'Enter a first name for this contact');

    // Created as the admin, so their own permissions apply.
    const created = await userClient().mutation({
      createPerson: {
        __args: {
          data: {
            name: { firstName, lastName },
            phones: { primaryPhoneNumber: `+${chatNumber(chatId)}`, primaryPhoneCountryCode: '', primaryPhoneCallingCode: '', additionalPhones: null },
          },
        },
        id: true,
      },
    });
    const id = created.createPerson?.id;
    if (!id) throw new Error('Could not create Person');

    return { person: { id, name: { firstName, lastName } }, createdPerson: true };
  }

  if (isPhoneLikeName(personName(existing)) && firstName) {
    await userClient().mutation({
      updatePerson: { __args: { id: existing.id, data: { name: { firstName, lastName } } }, id: true },
    });
    return { person: { ...existing, name: { firstName, lastName } }, createdPerson: false };
  }

  return { person: existing, createdPerson: false };
};

const handler = route<HistoryRequest>('whatsapp-history', async (event, logger) => {
  requireUser(event);

  if (!(await canManageConnection())) {
    throw new HttpError(403, 'Only workspace administrators can import WhatsApp history');
  }

  const request = event.body ?? {};

  if (request.rangeDays !== 0 && request.rangeDays !== 30 && request.rangeDays !== 90) {
    throw new HttpError(400, 'Invalid history range');
  }

  const status = await getBridgeStatus();

  if (status.state !== 'connected' || !status.phoneNumber) {
    throw new HttpError(409, 'WhatsApp is disconnected');
  }

  if (request.action === 'members') {
    if (!isGroupChatId(request.chatId)) throw new HttpError(400, 'Invalid group ID');
    return bridgePost('/history/members', { chatId: request.chatId });
  }

  if (request.action === 'list') {
    return listCandidates(request);
  }

  const chatId = request.chatId;

  if (request.action !== 'import' || !isChatId(chatId) || !Number.isInteger(request.offset) || request.offset! < 0) {
    throw new HttpError(400, 'Invalid history import request');
  }

  if (chatNumber(chatId) === digits(status.phoneNumber)) {
    throw new HttpError(400, 'Cannot import the linked account as a contact');
  }

  const history = await bridgePost<HistoryMessages>('/history/messages', { chatId, rangeDays: request.rangeDays, offset: request.offset, limit: 25 }, 30_000);
  const client = applicationClient();
  const accountId = await ensureAccount(client, `+${digits(status.phoneNumber)}`);
  const { person, createdPerson } = isGroupChatId(chatId)
    ? { person: undefined, createdPerson: false }
    : await resolvePerson(request, chatId, history.name);
  const name = person ? personName(person) || chatNumber(chatId) : history.name.slice(0, 120);
  const imported = await importChatMessages(client, accountId, chatId, name, history.messages, person);

  logger.info('Imported history page', { imported, offset: request.offset, createdPerson });
  return { imported, total: history.total, nextOffset: history.nextOffset, createdPerson };
});

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
