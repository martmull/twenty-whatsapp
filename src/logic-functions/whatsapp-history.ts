import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import { enqueueHistoryImport } from 'src/logic-functions/history-import';
import {
  applicationClient,
  ensureAccount,
  ensureConversation,
  findConversations,
  findPeopleByPhones,
  personName,
  userClient,
  type Person,
} from 'src/logic-functions/message-data';
import type { Logger } from 'src/logic-functions/utils/logger';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { chatNumber, digits, isChatId, isGroupChatId, isPhoneLikeName } from 'src/logic-functions/utils/validators';

type ChatSelection = {
  chatId?: string;
  createPerson?: boolean;
  firstName?: string;
  lastName?: string;
};

type HistoryRequest = {
  action?: 'list' | 'import' | 'members' | 'progress';
  rangeDays?: 0 | 30 | 90;
  kind?: 'all' | 'direct' | 'group';
  offset?: number;
  chatId?: string;
  acknowledged?: boolean;
  chats?: ChatSelection[];
};

const MAX_CHATS_PER_IMPORT = 50;

type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  messageCount: number;
  lastMessageAt?: string;
};

const listCandidates = async (request: HistoryRequest) => {
  const offset = request.offset ?? 0;
  const kind = request.kind ?? 'all';

  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000 || !['all', 'direct', 'group'].includes(kind)) {
    throw new HttpError(400, 'Invalid history request');
  }

  const history = await bridgePost<{ items: HistoryCandidate[]; total: number; historyReceivedAt?: string }>(
    '/history/list',
    { rangeDays: request.rangeDays, kind, offset, limit: 20 },
    30_000,
  );
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
      const renameable =
        matches.length === 1 &&
        isPhoneLikeName(matchedName || '') &&
        digits(matchedName || '') === chatNumber(item.chatId);

      return {
        ...item,
        name: renameable ? item.name : matchedName || item.name,
        match:
          matches.length === 1 ? ('matched' as const) : matches.length > 1 ? ('ambiguous' as const) : ('new' as const),
        personName: matchedName,
        renameable,
      };
    }),
  };
};

// Finds the Person for a direct chat, creating or renaming them as the admin asked.
const resolvePerson = async (
  request: ChatSelection,
  chatId: string,
  historyName: string,
  matches: Person[],
): Promise<{ person: Person; createdPerson: boolean }> => {
  if (matches.length > 1) {
    throw new HttpError(409, 'More than one Person has this phone number');
  }

  for (const value of [request.firstName, request.lastName]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 80 || !value.trim())) {
      throw new HttpError(400, 'Invalid Person name');
    }
  }

  const [suggestedFirstName = '', ...suggestedLastName] = isPhoneLikeName(historyName)
    ? []
    : historyName.trim().split(/\s+/);
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
            phones: {
              primaryPhoneNumber: `+${chatNumber(chatId)}`,
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

// Creates the People and conversations of the selected chats, then hands the messages to the
// background import. Chats that cannot be imported are reported without stopping the others.
const queueImport = async (request: HistoryRequest, accountPhoneNumber: string, logger: Logger) => {
  const chats = request.chats;

  if (
    request.acknowledged !== true ||
    !Array.isArray(chats) ||
    chats.length === 0 ||
    chats.length > MAX_CHATS_PER_IMPORT ||
    !chats.every((chat) => isChatId(chat?.chatId)) ||
    new Set(chats.map((chat) => chat.chatId)).size !== chats.length
  ) {
    throw new HttpError(400, 'Invalid history import request');
  }

  const chatIds = chats.map((chat) => chat.chatId as string);

  if (chatIds.some((chatId) => chatNumber(chatId) === accountPhoneNumber)) {
    throw new HttpError(400, 'Cannot import the linked account as a contact');
  }

  const client = applicationClient();
  const [names, accountId] = await Promise.all([
    bridgePost<{ chatId: string; name: string }[]>('/history/names', { chatIds }, 30_000),
    ensureAccount(client, `+${accountPhoneNumber}`),
  ]);
  const nameByChatId = new Map(names.map(({ chatId, name }) => [chatId, name]));
  const [peopleByPhone, conversations] = await Promise.all([
    findPeopleByPhones(client, chatIds.filter((chatId) => !isGroupChatId(chatId)).map(chatNumber)),
    findConversations(client, accountId, chatIds),
  ]);
  const resolved: { chatId: string; name: string; person?: Person }[] = [];
  const failures: { chatId: string; error: string }[] = [];
  let createdPeople = 0;

  for (const chat of chats) {
    const chatId = chat.chatId as string;
    const historyName = nameByChatId.get(chatId) ?? chatNumber(chatId);

    try {
      const { person, createdPerson } = isGroupChatId(chatId)
        ? { person: undefined, createdPerson: false }
        : await resolvePerson(chat, chatId, historyName, peopleByPhone.get(chatNumber(chatId)) ?? []);
      createdPeople += Number(createdPerson);
      resolved.push({
        chatId,
        name: person ? personName(person) || chatNumber(chatId) : historyName.slice(0, 120),
        person,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      failures.push({ chatId, error: error.message });
    }
  }

  const missing = resolved.filter(({ chatId }) => !conversations.has(chatId));
  const createdIdByChatId = new Map<string, string>();

  if (missing.length > 0) {
    const created = await client.mutation({
      createWhatsappConversations: {
        __args: {
          data: missing.map(({ chatId, name, person }) => ({
            name,
            chatId,
            accountId,
            ...(person ? { personId: person.id } : {}),
          })),
        },
        id: true,
        chatId: true,
      },
    });
    for (const { id, chatId } of created.createWhatsappConversations ?? []) {
      if (id && chatId) createdIdByChatId.set(chatId, id);
    }
  }

  const tasks: { chatId: string; conversationId: string; rangeDays: 0 | 30 | 90 }[] = [];

  for (const { chatId, name, person } of resolved) {
    const existing = conversations.get(chatId);
    // ensureConversation renames an existing conversation still named after its phone number.
    const conversationId = existing
      ? (await ensureConversation(client, accountId, chatId, name, person, existing)).id
      : createdIdByChatId.get(chatId);
    if (!conversationId) throw new Error('Could not create WhatsApp conversation');
    tasks.push({ chatId, conversationId, rangeDays: request.rangeDays as 0 | 30 | 90 });
  }

  if (tasks.length > 0) {
    const { runToken } = await bridgePost<{ runToken?: string }>('/history/imports/queue', { tasks }, 30_000);

    if (runToken) {
      // The chats stay queued on the bridge; the cron restarts the import if this enqueue fails.
      await enqueueHistoryImport(runToken, 0).catch((error: unknown) =>
        logger.error('Could not start the history import', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  logger.info('Queued history import', { queued: tasks.length, failed: failures.length, createdPeople });
  return { queued: tasks.length, createdPeople, failures };
};

const handler = route<HistoryRequest>('whatsapp-history', async (event, logger) => {
  requireUser(event);

  if (!(await canManageConnection())) {
    throw new HttpError(403, 'Only workspace administrators can import WhatsApp history');
  }

  const request = event.body ?? {};

  // Answered by the bridge alone, so polling it costs no Twenty API request.
  if (request.action === 'progress') {
    return bridgePost('/history/imports/progress', {}, 10_000).catch(() => {
      throw new HttpError(502, 'WhatsApp bridge is unavailable');
    });
  }

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

  if (request.action === 'import') {
    return queueImport(request, digits(status.phoneNumber), logger);
  }

  throw new HttpError(400, 'Invalid history request');
});

export default defineLogicFunction({
  universalIdentifier: '6e6ef756-2022-4d4d-93af-3f1a95fe5a86',
  name: 'whatsapp-history',
  description: 'Review available WhatsApp history and queue selected chats for a background import.',
  timeoutSeconds: 60,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/history',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
