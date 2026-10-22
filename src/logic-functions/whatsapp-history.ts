import type { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgePost, getBridgeStatus, isBridgeOutdated } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import { enqueueHistoryImport, FIRST_PAGE, type ChainPosition } from 'src/logic-functions/history-import';
import { cancelHistoryJobs } from 'src/logic-functions/import-cancellation';
import {
  applicationClient,
  ensureAccount,
  findConversations,
  findPeopleByPhones,
  personName,
  planSavedContactPeople,
  userClient,
  type ContactName,
  type Person,
  type SavedContact,
} from 'src/logic-functions/message-data';
import { deterministicId, upsertConversations, upsertPeople } from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { chatNumber, digits, isChatId, isGroupChatId, isPhoneLikeName } from 'src/logic-functions/utils/validators';

const RANGE_DAYS = [7, 30, 90, 365];

type ChatSelection = {
  chatId?: string;
  createPerson?: boolean;
  firstName?: string;
  lastName?: string;
};

type HistoryRequest = {
  action?: 'list' | 'import' | 'sync' | 'progress' | 'cancel';
  // For `sync`: whether the chats' new messages are synced.
  enabled?: boolean;
  rangeDays?: number;
  kind?: 'all' | 'direct' | 'group';
  offset?: number;
  chats?: ChatSelection[];
};

const MAX_CHATS_PER_IMPORT = 50;

type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  firstName?: string;
  lastName?: string;
  messageCount: number;
  lastMessageAt?: string;
};
type GroupMember = { phoneNumber?: string; firstName?: string; lastName?: string; isSavedContact?: boolean };

// Each chat says whether its new messages are synced: its conversation exists and syncing is on.
const listCandidates = async (request: HistoryRequest, accountPhoneNumber: string, cachedAccountId?: string) => {
  const offset = request.offset ?? 0;
  const kind = request.kind ?? 'all';

  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000 || !['all', 'direct', 'group'].includes(kind)) {
    throw new HttpError(400, 'Invalid history request');
  }

  const client = applicationClient();
  const [history, accountId] = await Promise.all([
    bridgePost<{ items: HistoryCandidate[]; total: number; historyReceivedAt?: string }>(
      '/history/list',
      { rangeDays: request.rangeDays, kind, offset, limit: 50 },
      30_000,
    ),
    cachedAccountId ?? ensureAccount(client, `+${accountPhoneNumber}`),
  ]);
  const conversations = await findConversations(
    client,
    accountId,
    history.items.map((item) => item.chatId),
  );

  return {
    ...history,
    items: history.items.map((item) => {
      const conversation = conversations.get(item.chatId);
      return { ...item, synced: Boolean(conversation) && conversation?.isSyncEnabled !== false };
    }),
  };
};

type PersonPlan = { person?: Person; write?: Record<string, unknown>; createdPerson: boolean };

// A selected chat is imported either way: it links to the one Person with its number, if any, and
// creates or renames that Person only when People creation is on.
const planPerson = (
  request: ChatSelection,
  chatId: string,
  contact: Omit<ContactName, 'chatId'>,
  matches: Person[],
): PersonPlan => {
  for (const value of [request.firstName, request.lastName]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 80)) {
      throw new HttpError(400, 'Invalid Person name');
    }
  }

  const [suggestedFirstName = '', ...suggestedLastName] = contact.firstName
    ? [contact.firstName, contact.lastName ?? '']
    : isPhoneLikeName(contact.name)
      ? []
      : contact.name.trim().split(/\s+/);
  // An edited first name comes with the last name as typed, which may be blank.
  const [firstName, lastName] = request.firstName?.trim()
    ? [request.firstName.trim(), request.lastName?.trim() ?? '']
    : [suggestedFirstName, suggestedLastName.join(' ')];
  if (matches.length > 1) {
    return { createdPerson: false };
  }

  const existing = matches[0];

  if (!existing) {
    if (request.createPerson !== true || !firstName) return { createdPerson: false };

    const phoneNumber = `+${chatNumber(chatId)}`;
    // Derived from the number, so submitting the same import twice cannot create the Person twice.
    const id = deterministicId('person', phoneNumber);

    return {
      person: { id, name: { firstName, lastName } },
      createdPerson: true,
      write: {
        id,
        name: { firstName, lastName },
        phones: {
          primaryPhoneNumber: phoneNumber,
          primaryPhoneCountryCode: '',
          primaryPhoneCallingCode: '',
          additionalPhones: null,
        },
      },
    };
  }

  if (request.createPerson === true && isPhoneLikeName(personName(existing)) && firstName) {
    return {
      person: { ...existing, name: { firstName, lastName } },
      createdPerson: false,
      write: { id: existing.id, name: { firstName, lastName } },
    };
  }

  return { person: existing, createdPerson: false };
};

// Members of the selected groups saved in the phone's address book. A group whose members cannot be
// read is still imported.
const savedGroupMembers = async (groupChatIds: string[], logger: Logger): Promise<SavedContact[]> => {
  const members = await Promise.all(
    groupChatIds.map((chatId) =>
      bridgePost<GroupMember[]>('/history/members', { chatId }, 30_000).catch(() => {
        logger.warn('Could not read group members', { chatId });
        return [];
      }),
    ),
  );

  return members
    .flat()
    .flatMap(({ phoneNumber, firstName, lastName, isSavedContact }) =>
      isSavedContact && phoneNumber && firstName ? [{ phoneNumber, firstName, lastName: lastName ?? '' }] : [],
    );
};

const validChatIds = (request: HistoryRequest): string[] => {
  const chats = request.chats;

  if (
    !Array.isArray(chats) ||
    chats.length === 0 ||
    chats.length > MAX_CHATS_PER_IMPORT ||
    !chats.every((chat) => isChatId(chat?.chatId)) ||
    new Set(chats.map((chat) => chat.chatId)).size !== chats.length
  ) {
    throw new HttpError(400, 'Invalid history import request');
  }

  return chats.map((chat) => chat.chatId as string);
};

type ConversationDependencies = {
  client?: CoreApiClient;
  // Writes People as the admin, so their own permissions apply.
  adminClient?: CoreApiClient;
};

type QueueImportDependencies = ConversationDependencies & {
  enqueue?: (runToken: string, delayMs: number, position?: ChainPosition) => Promise<void>;
};

type PreparedConversations = {
  conversationIdByChatId: Map<string, string>;
  createdPeople: number;
  failures: { chatId: string; error: string }[];
};

// Creates the People and conversations of the selected chats. Chats that cannot be prepared are
// reported without stopping the others. People and conversations are each written in one upsert,
// whatever the number of chats. `enableSync` turns syncing on, for new and existing conversations.
const prepareConversations = async (
  request: HistoryRequest,
  accountPhoneNumber: string,
  createPeople: boolean,
  enableSync: boolean,
  logger: Logger,
  { client = applicationClient(), adminClient = userClient() }: ConversationDependencies,
): Promise<PreparedConversations> => {
  const chatIds = validChatIds(request);
  const chats = (request.chats ?? []).map((chat) => ({
    ...chat,
    createPerson: createPeople && chat.createPerson === true,
  }));

  if (chatIds.some((chatId) => chatNumber(chatId) === accountPhoneNumber)) {
    throw new HttpError(400, 'Cannot import the linked account as a contact');
  }

  const [names, accountId] = await Promise.all([
    bridgePost<ContactName[]>('/history/names', { chatIds }, 30_000),
    ensureAccount(client, `+${accountPhoneNumber}`),
  ]);
  const contactByChatId = new Map(names.map(({ chatId, ...contact }) => [chatId, contact]));
  const groupMembers = await savedGroupMembers(
    chats
      .filter((chat) => isGroupChatId(chat.chatId) && chat.createPerson === true)
      .map((chat) => chat.chatId as string),
    logger,
  );
  const [peopleByPhone, conversations] = await Promise.all([
    findPeopleByPhones(client, [
      ...chatIds.filter((chatId) => !isGroupChatId(chatId)).map(chatNumber),
      ...groupMembers.map((member) => digits(member.phoneNumber)),
    ]),
    findConversations(client, accountId, chatIds),
  ]);
  const resolved: { chatId: string; name: string; person?: Person }[] = [];
  const personWrites: Record<string, unknown>[] = [];
  const failures: { chatId: string; error: string }[] = [];
  let createdPeople = 0;

  for (const chat of chats) {
    const chatId = chat.chatId as string;
    const contact = contactByChatId.get(chatId) ?? { name: chatNumber(chatId) };

    try {
      const { person, write, createdPerson } = isGroupChatId(chatId)
        ? { person: undefined, write: undefined, createdPerson: false }
        : planPerson(chat, chatId, contact, peopleByPhone.get(chatNumber(chatId)) ?? []);
      if (write) personWrites.push(write);
      createdPeople += Number(createdPerson);
      resolved.push({
        chatId,
        name: person ? personName(person) || chatNumber(chatId) : contact.name.slice(0, 120),
        person,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      failures.push({ chatId, error: error.message });
    }
  }

  // Saved members of the imported groups join the same upsert; other members are left out.
  const planned = new Set(personWrites.map((write) => write.id));
  const memberWrites = planSavedContactPeople(groupMembers, peopleByPhone)
    .map(({ write }) => write)
    .filter((write) => !planned.has(write.id));
  createdPeople += memberWrites.length;

  if (personWrites.length + memberWrites.length > 0) {
    await upsertPeople(adminClient, [...personWrites, ...memberWrites]);
  }

  const conversationWrites = resolved.flatMap(({ chatId, name, person }) => {
    const existing = conversations.get(chatId);

    if (!existing) {
      return [
        {
          id: deterministicId('conversation', `${accountId}:${chatId}`),
          name,
          chatId,
          accountId,
          isSyncEnabled: enableSync,
          ...(person ? { personId: person.id } : {}),
        },
      ];
    }

    // A conversation still named after its phone number takes the contact's name.
    const rename =
      isPhoneLikeName(existing.name) && name.trim() && !isPhoneLikeName(name)
        ? { name: name.trim().slice(0, 120) }
        : {};
    const sync = enableSync && existing.isSyncEnabled === false ? { isSyncEnabled: true } : {};
    return Object.keys({ ...rename, ...sync }).length > 0 ? [{ id: existing.id, ...rename, ...sync }] : [];
  });
  const writtenIdByChatId = new Map(
    (conversationWrites.length > 0 ? await upsertConversations(client, conversationWrites) : []).map(
      ({ id, chatId }) => [chatId, id],
    ),
  );
  const conversationIdByChatId = new Map(
    resolved.map(({ chatId }) => {
      const conversationId = conversations.get(chatId)?.id ?? writtenIdByChatId.get(chatId);
      if (!conversationId) throw new Error('Could not create WhatsApp conversation');
      return [chatId, conversationId];
    }),
  );

  logger.info('Prepared conversations', { chats: resolved.length, failed: failures.length, createdPeople });
  return { conversationIdByChatId, createdPeople, failures };
};

// Hands the messages of the selected chats to the background import. A new conversation is not
// synced until an admin turns syncing on.
export const queueImport = async (
  request: HistoryRequest,
  accountPhoneNumber: string,
  createPeople: boolean,
  logger: Logger,
  { enqueue = enqueueHistoryImport, ...dependencies }: QueueImportDependencies = {},
) => {
  const { conversationIdByChatId, createdPeople, failures } = await prepareConversations(
    request,
    accountPhoneNumber,
    createPeople,
    false,
    logger,
    dependencies,
  );
  const tasks = [...conversationIdByChatId].map(([chatId, conversationId]) => ({
    chatId,
    conversationId,
    rangeDays: request.rangeDays as 0 | 30 | 90,
  }));

  if (tasks.length > 0) {
    const { runToken } = await bridgePost<{ runToken?: string }>('/history/imports/queue', { tasks }, 30_000);

    if (runToken) {
      // The chats stay queued on the bridge, which restarts the import if this enqueue fails.
      await enqueue(runToken, 0, FIRST_PAGE).catch((error: unknown) =>
        logger.error('Could not start the history import', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  logger.info('Queued history import', { queued: tasks.length, failed: failures.length, createdPeople });
  return { queued: tasks.length, createdPeople, failures };
};

// Turns syncing of new messages on (creating the conversations it needs) or off for the selected chats.
export const updateSync = async (
  request: HistoryRequest,
  accountPhoneNumber: string,
  createPeople: boolean,
  logger: Logger,
  dependencies: ConversationDependencies = {},
) => {
  if (typeof request.enabled !== 'boolean') {
    throw new HttpError(400, 'Invalid sync request');
  }

  if (request.enabled) {
    const { conversationIdByChatId, createdPeople, failures } = await prepareConversations(
      request,
      accountPhoneNumber,
      createPeople,
      true,
      logger,
      dependencies,
    );
    return { updated: conversationIdByChatId.size, createdPeople, failures };
  }

  const chatIds = validChatIds(request);
  const client = dependencies.client ?? applicationClient();
  const accountId = await ensureAccount(client, `+${accountPhoneNumber}`);
  const synced = [...(await findConversations(client, accountId, chatIds)).values()].filter(
    (conversation) => conversation.isSyncEnabled !== false,
  );

  if (synced.length > 0) {
    await upsertConversations(
      client,
      synced.map((conversation) => ({ id: conversation.id, isSyncEnabled: false })),
    );
  }

  logger.info('Stopped syncing chats', { count: synced.length });
  return { updated: synced.length, createdPeople: 0, failures: [] };
};

// Stops the running import: the bridge drops the chats and files still queued, and the chain's job
// IDs are recorded so jobs Twenty already queued stop as soon as they start.
const cancelImport = async (logger: Logger) => {
  const result = await bridgePost<{ cancelled: number; runToken?: string; media?: { cancelled: number } }>(
    '/history/imports/cancel',
    {},
    10_000,
  ).catch(() => {
    throw new HttpError(502, 'WhatsApp bridge is unavailable');
  });

  if (result.runToken) {
    await cancelHistoryJobs(result.runToken).catch((error: unknown) =>
      logger.warn('Could not record the cancelled history jobs', { error: String(error) }),
    );
  }

  logger.info('Cancelled history import', { chats: result.cancelled, files: result.media?.cancelled ?? 0 });
  return { cancelled: result.cancelled };
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

  if (request.action === 'cancel') {
    return cancelImport(logger);
  }

  if (request.action !== 'sync' && !RANGE_DAYS.includes(request.rangeDays ?? 0)) {
    throw new HttpError(400, 'Invalid history range');
  }

  const status = await getBridgeStatus();

  if (status.state !== 'connected' || !status.phoneNumber) {
    throw new HttpError(409, 'WhatsApp is disconnected');
  }

  if (isBridgeOutdated(status)) {
    throw new HttpError(426, 'The running WhatsApp bridge is older than the app: restart it to load the update');
  }

  if (request.action === 'list') {
    return listCandidates(request, digits(status.phoneNumber), status.twentyAccountId);
  }

  if (request.action === 'import') {
    return queueImport(request, digits(status.phoneNumber), status.createPeople === true, logger);
  }

  if (request.action === 'sync') {
    return updateSync(request, digits(status.phoneNumber), status.createPeople === true, logger);
  }

  throw new HttpError(400, 'Invalid history request');
});

export default defineLogicFunction({
  universalIdentifier: '6e6ef756-2022-4d4d-93af-3f1a95fe5a86',
  name: 'whatsapp-history',
  description: 'List WhatsApp chats, import their history in the background, and turn syncing on or off.',
  timeoutSeconds: 60,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/history',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
