import type { CoreApiClient } from 'twenty-client-sdk/core';
import { enqueueJobs } from 'twenty-sdk/logic-function';

import { HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { bridgePost, reportRateLimit } from 'src/logic-functions/bridge-request';
import { isHistoryJobCancelled } from 'src/logic-functions/import-cancellation';
import { enqueueWithRetry } from 'src/logic-functions/job-chain';
import { queueMedia } from 'src/logic-functions/media-import';
import {
  applicationClient,
  isValidBridgeEvent,
  messageRecord,
  nodesOf,
  summaryPatch,
  type BridgeMessageEvent,
  type Conversation,
} from 'src/logic-functions/message-data';
import { pendingMedia, type MediaItem } from 'src/logic-functions/message-media';
import {
  countingClient,
  MAX_UPSERT_RECORDS,
  rateLimitRetryAfterMs,
  upsertConversations,
  upsertMessages,
} from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import { isUuid } from 'src/logic-functions/utils/validators';

// History import runs as a chain of jobs, one page per job. The bridge paces the chain: it grants
// each page from its API budget, or tells the job when to come back.
const RETRY_DELAY_MS = 30_000;
// Platform retries of a page are safe: the bridge hands the same page back and writes are upserts.
const HISTORY_JOB_RETRY_LIMIT = 2;

type PageChat = { chatId: string; conversationId: string; messages: BridgeMessageEvent[]; isLastPage: boolean };
type PageSummary = {
  chatId: string;
  conversationId: string;
  lastMessage?: { sentAt: string; text: string };
  lastInboundAt?: string;
};
type HistoryImportPage = { leaseId: string; pageSeq: number; chats: PageChat[]; summaries: PageSummary[] };
type ChainStep = { remaining: number; pageSeq?: number; nextJobKey?: string; nextRunInMs?: number };
type ClaimWait = { waitMs: number; pageSeq: number; nextJobKey: string };

export type HistoryImportPayload = { runToken?: unknown; pageSeq?: unknown };

export type HistoryImportStepResult =
  | { status: 'idle' }
  | { status: 'waiting'; waitMs: number }
  | { status: 'imported'; imported: number; remaining: number; nextRunInMs: number }
  | { status: 'failed'; remaining: number; nextRunInMs: number };

// Where the chain stands: the page the next job claims, and the key naming that job.
export type ChainPosition = { pageSeq: number; jobKey: string };
type EnqueueHistory = (runToken: string, delayMs: number, position?: ChainPosition) => Promise<void>;

// Each page gets its own job ID, so a page job queued twice (a retry after it queued the next one)
// runs once.
export const historyJobId = (runToken: string, jobKey: string) => `history.${runToken}.${jobKey}`;

// A new chain starts at page 0.
export const FIRST_PAGE: ChainPosition = { pageSeq: 0, jobKey: '0' };

export const enqueueHistoryImport: EnqueueHistory = async (runToken, delayMs, position) => {
  await enqueueJobs({
    logicFunctionUniversalIdentifier: HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
    jobs: [
      position
        ? { payload: { runToken, pageSeq: position.pageSeq }, jobId: historyJobId(runToken, position.jobKey) }
        : { payload: { runToken } },
    ],
    delayMs,
    retryLimit: HISTORY_JOB_RETRY_LIMIT,
  });
};

// Writes the summaries of finished chats: one query for their current values, one upsert.
const writeSummaries = async (client: CoreApiClient, summaries: PageSummary[]): Promise<void> => {
  const ids = summaries.map((summary) => summary.conversationId).filter(isUuid);
  if (ids.length === 0) return;

  const result = await client.query({
    whatsappConversations: {
      __args: { filter: { id: { in: ids } }, first: MAX_UPSERT_RECORDS },
      edges: { node: { id: true, lastMessageAt: true, lastInboundAt: true, lastPreview: true } },
    },
  });
  const conversationById = new Map(
    nodesOf<Pick<Conversation, 'id' | 'lastMessageAt' | 'lastInboundAt' | 'lastPreview'>>(
      result.whatsappConversations,
    ).map((conversation) => [conversation.id, conversation]),
  );
  const writes = summaries.flatMap((summary) => {
    const conversation = conversationById.get(summary.conversationId);
    const patch =
      conversation &&
      summaryPatch(conversation, { latest: summary.lastMessage, latestInboundAt: summary.lastInboundAt });
    return patch ? [{ id: summary.conversationId, ...patch }] : [];
  });

  if (writes.length > 0) {
    await upsertConversations(client, writes);
  }
};

// The page's chats whose conversation no longer exists in Twenty: they were queued before it was
// deleted, so retrying them can never succeed.
const chatsWithDeletedConversation = async (client: CoreApiClient, page: HistoryImportPage): Promise<string[]> => {
  const ids = [...new Set(page.chats.map((chat) => chat.conversationId).filter(isUuid))];
  if (ids.length === 0) return [];

  const result = await client.query({
    whatsappConversations: {
      __args: { filter: { id: { in: ids } }, first: MAX_UPSERT_RECORDS },
      edges: { node: { id: true } },
    },
  });
  const existing = new Set(
    nodesOf<{ id: string }>(result.whatsappConversations).map((conversation) => conversation.id),
  );
  return page.chats.filter((chat) => !existing.has(chat.conversationId)).map((chat) => chat.chatId);
};

type ImportedPage = { importedByChat: Record<string, number>; imported: number; media: MediaItem[] };

// One messages upsert for every chat of the page; existing messages are matched, not duplicated.
const importPage = async (client: CoreApiClient, page: HistoryImportPage): Promise<ImportedPage> => {
  // Invalid events are skipped for good: reporting past them keeps the chain moving.
  const chats = page.chats.map((chat) => ({
    ...chat,
    messages: (chat.messages ?? []).filter((event) => event.chatId === chat.chatId && isValidBridgeEvent(event)),
  }));
  const chatIdByConversationId = new Map(chats.map((chat) => [chat.conversationId, chat.chatId]));
  const records = chats.flatMap((chat) => chat.messages.map((event) => messageRecord(event, chat.conversationId)));
  const written = records.length > 0 ? await upsertMessages(client, records) : [];

  if (page.summaries?.length) {
    await writeSummaries(client, page.summaries);
  }

  const importedByChat: Record<string, number> = {};
  for (const message of written.filter((item) => item.created)) {
    const chatId = chatIdByConversationId.get(message.conversationId);
    if (chatId) importedByChat[chatId] = (importedByChat[chatId] ?? 0) + 1;
  }

  return {
    importedByChat,
    imported: written.filter((item) => item.created).length,
    media: pendingMedia(
      written,
      chats.flatMap((chat) => chat.messages),
    ),
  };
};

type HistoryImportDependencies = {
  client?: CoreApiClient;
  enqueue?: EnqueueHistory;
  queueFiles?: (items: MediaItem[]) => Promise<unknown>;
  isCancelled?: (jobId: string) => Promise<boolean>;
};

// Imports one page of queued history, then schedules the next job while work remains.
export const runHistoryImportStep = async (
  payload: HistoryImportPayload,
  logger: Logger,
  {
    client = applicationClient(),
    enqueue = enqueueHistoryImport,
    queueFiles = (items) => queueMedia(items, 'history'),
    isCancelled = isHistoryJobCancelled,
  }: HistoryImportDependencies = {},
): Promise<HistoryImportStepResult> => {
  const { runToken } = payload ?? {};
  const pageSeq = Number.isSafeInteger(payload?.pageSeq) ? (payload.pageSeq as number) : undefined;

  if (!isUuid(runToken)) {
    return { status: 'idle' };
  }

  if (await isCancelled(historyJobId(runToken, `${pageSeq ?? 0}`))) {
    logger.info('History import was cancelled');
    return { status: 'idle' };
  }

  const claimed = await bridgePost<HistoryImportPage | ClaimWait | { stale: true } | { done: true }>(
    '/history/imports/claim',
    { runToken, ...(pageSeq !== undefined ? { pageSeq } : {}) },
    30_000,
  );

  if ('waitMs' in claimed) {
    await enqueueWithRetry(
      () => enqueue(runToken, claimed.waitMs, { pageSeq: claimed.pageSeq, jobKey: claimed.nextJobKey }),
      logger,
    );
    return { status: 'waiting', waitMs: claimed.waitMs };
  }

  if (!('leaseId' in claimed)) {
    logger.info('History import chain ended', { reason: 'done' in claimed ? 'done' : 'superseded' });
    return { status: 'idle' };
  }

  if (!Array.isArray(claimed.chats)) {
    // A bridge from before pages held several chats: importing from it would fail on every page.
    logger.error('The WhatsApp bridge is older than this app: update and restart it to import history');
    await bridgePost('/history/imports/release', { leaseId: claimed.leaseId, failed: false, nextRunInMs: 0 }).catch(
      () => undefined,
    );
    return { status: 'idle' };
  }

  const page = claimed;
  const startedAt = Date.now();
  const counter = { requests: 0 };
  const countedClient = countingClient(client, counter);
  let step: ChainStep;
  let result: HistoryImportStepResult;

  try {
    const imported = await importPage(countedClient, page);

    // Files wait in the bridge's media queue, so the chain never waits behind them.
    await queueFiles(imported.media);

    step = await bridgePost<ChainStep>('/history/imports/complete', {
      leaseId: page.leaseId,
      imported: imported.importedByChat,
      nextRunInMs: 0,
      requests: counter.requests,
      elapsedMs: Date.now() - startedAt,
    });
    // The bridge spaces the pages to fit Twenty's job and API limits.
    const nextRunInMs = step.nextRunInMs ?? 0;

    logger.info('Imported history page', {
      chats: page.chats.length,
      summaries: page.summaries?.length ?? 0,
      imported: imported.imported,
      requests: counter.requests,
      remaining: step.remaining,
    });
    result = { status: 'imported', imported: imported.imported, remaining: step.remaining, nextRunInMs };
  } catch (error) {
    const retryAfterMs = rateLimitRetryAfterMs(error);
    const abandonedChatIds =
      retryAfterMs === undefined ? await chatsWithDeletedConversation(countedClient, page).catch(() => []) : [];
    // The other chats of the page are retried at once, without counting a failure against them.
    const nextRunInMs = retryAfterMs ?? (abandonedChatIds.length > 0 ? 0 : RETRY_DELAY_MS);
    logger.warn(
      abandonedChatIds.length > 0 ? 'Skipping chats whose conversation was deleted' : 'Could not import history page',
      {
        chats: page.chats.map((chat) => chat.chatId),
        abandonedChatIds,
        rateLimited: retryAfterMs !== undefined,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    if (retryAfterMs !== undefined) await reportRateLimit(retryAfterMs);
    // Rate limiting is not the chats' fault, so it does not count toward setting them aside.
    step = await bridgePost<ChainStep>('/history/imports/release', {
      leaseId: page.leaseId,
      failed: retryAfterMs === undefined,
      nextRunInMs,
      requests: counter.requests,
      ...(abandonedChatIds.length > 0 ? { abandonedChatIds } : {}),
    });
    result = { status: 'failed', remaining: step.remaining, nextRunInMs };
  }

  if (result.remaining > 0) {
    // If this keeps failing, the bridge replaces the chain once the scheduled run is overdue.
    const position =
      step.pageSeq !== undefined && step.nextJobKey ? { pageSeq: step.pageSeq, jobKey: step.nextJobKey } : undefined;
    await enqueueWithRetry(() => enqueue(runToken, result.nextRunInMs, position), logger);
  }

  return result;
};
