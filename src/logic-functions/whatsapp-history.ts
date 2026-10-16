import { defineLogicFunction } from 'twenty-sdk/define';
import { enqueueJobs, getJobs } from 'twenty-sdk/logic-function';

import { HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import { applicationClient, findPeopleByPhones, personName } from 'src/logic-functions/message-data';
import type { HistoryImportJob } from 'src/logic-functions/whatsapp-history-import-job';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { chatNumber, digits, isChatId, isGroupChatId, isPhoneLikeName } from 'src/logic-functions/utils/validators';

type ImportChat = { chatId: string; createPerson?: boolean; firstName?: string; lastName?: string };

type HistoryRequest = {
  action?: 'list' | 'import' | 'progress' | 'members';
  rangeDays?: 0 | 30 | 90;
  kind?: 'all' | 'direct' | 'group';
  offset?: number;
  chatId?: string;
  chats?: ImportChat[];
  jobIds?: string[];
  acknowledged?: boolean;
};

type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  messageCount: number;
  lastMessageAt?: string;
};

// getJobs and enqueueJobs both take at most 200 jobs.
const MAX_JOBS = 200;

const isOptionalName = (value: unknown) =>
  value === undefined || (typeof value === 'string' && value.trim() !== '' && value.length <= 80);

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

const handler = route<HistoryRequest>('whatsapp-history', async (event, logger) => {
  requireUser(event);

  if (!(await canManageConnection())) {
    throw new HttpError(403, 'Only workspace administrators can import WhatsApp history');
  }

  const request = event.body ?? {};

  // Import jobs report their state by job ID; the page polls this while an import runs.
  if (request.action === 'progress') {
    const jobIds = request.jobIds;
    if (!Array.isArray(jobIds) || jobIds.length > MAX_JOBS || !jobIds.every((id) => typeof id === 'string')) {
      throw new HttpError(400, 'Invalid job IDs');
    }
    const jobs = await getJobs(jobIds);
    return { jobs: jobs.map(({ jobId, state, failedReason }) => ({ jobId, state, failedReason })) };
  }

  const rangeDays = request.rangeDays;

  if (rangeDays !== 0 && rangeDays !== 30 && rangeDays !== 90) {
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

  if (request.action !== 'import') {
    throw new HttpError(400, 'Invalid history request');
  }

  const chats = request.chats;
  const ownNumber = digits(status.phoneNumber);

  if (
    request.acknowledged !== true ||
    !Array.isArray(chats) ||
    chats.length === 0 ||
    chats.length > MAX_JOBS ||
    chats.some(
      (chat) =>
        !isChatId(chat.chatId) ||
        chatNumber(chat.chatId) === ownNumber ||
        !isOptionalName(chat.firstName) ||
        !isOptionalName(chat.lastName),
    )
  ) {
    throw new HttpError(400, 'Invalid history import request');
  }

  // One background job per chat: the import keeps going if the page is closed.
  const { jobIds } = await enqueueJobs({
    logicFunctionUniversalIdentifier: HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
    jobs: chats.map((chat) => ({
      payload: {
        chatId: chat.chatId,
        rangeDays,
        createPerson: chat.createPerson === true,
        firstName: chat.firstName,
        lastName: chat.lastName,
      } satisfies HistoryImportJob,
    })),
    retryLimit: 3,
  });

  logger.info('Queued history import', { chats: chats.length });
  return { jobIds };
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
