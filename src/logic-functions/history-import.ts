import type { CoreApiClient } from 'twenty-client-sdk/core';
import { enqueueJobs } from 'twenty-sdk/logic-function';

import { HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { bridgePost } from 'src/logic-functions/bridge-request';
import { enqueueMediaImports } from 'src/logic-functions/media-import';
import {
  applicationClient,
  isValidBridgeEvent,
  messageRecord,
  nodesOf,
  summaryPatch,
  type BridgeMessageEvent,
  type Conversation,
} from 'src/logic-functions/message-data';
import { attachMedia, pendingMedia, type MediaItem } from 'src/logic-functions/message-media';
import {
  MAX_UPSERT_RECORDS,
  rateLimitRetryAfterMs,
  upsertConversations,
  upsertMessages,
} from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import { isUuid } from 'src/logic-functions/utils/validators';

// History import runs as a chain of jobs, one page per job, paced to leave most of the app's API
// budget (500 requests per minute, shared by every workspace using the app) to live sync and the UI.
export const HISTORY_IMPORT_REQUESTS_PER_MINUTE = 120;
const RETRY_DELAY_MS = 30_000;
// Platform retries of a page are safe: the bridge hands the same page back and writes are upserts.
const HISTORY_JOB_RETRY_LIMIT = 2;
const INLINE_MEDIA_TIME_BUDGET_MS = 120_000;

type PageChat = { chatId: string; conversationId: string; messages: BridgeMessageEvent[]; isLastPage: boolean };
type PageSummary = {
  chatId: string;
  conversationId: string;
  lastMessage?: { sentAt: string; text: string };
  lastInboundAt?: string;
};
type HistoryImportPage = { leaseId: string; pageSeq: number; chats: PageChat[]; summaries: PageSummary[] };
type ChainStep = { remaining: number; pageSeq?: number; nextJobKey?: string };

export type HistoryImportPayload = { runToken?: unknown; pageSeq?: unknown };

export type HistoryImportStepResult =
  | { status: 'idle' }
  | { status: 'imported'; imported: number; remaining: number; nextRunInMs: number }
  | { status: 'failed'; remaining: number; nextRunInMs: number };

// Where the chain stands: the page the next job claims, and the key naming that job.
export type ChainPosition = { pageSeq: number; jobKey: string };
type EnqueueHistory = (runToken: string, delayMs: number, position?: ChainPosition) => Promise<void>;

// Spreads requests evenly: a job that made N requests waits until N requests' worth of budget has passed.
export const paceDelay = (requests: number, elapsedMs: number): number =>
  Math.max(0, Math.ceil((requests * 60_000) / HISTORY_IMPORT_REQUESTS_PER_MINUTE - elapsedMs));

const countRequests = (client: CoreApiClient, counter: { requests: number }): CoreApiClient =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'query' || property === 'mutation') && typeof value === 'function') {
        return (...args: unknown[]) => {
          counter.requests += 1;
          return value.apply(target, args);
        };
      }
      return value;
    },
  });

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
  enqueueMedia?: (items: MediaItem[]) => Promise<unknown>;
};

// Imports one page of queued history, then schedules the next job while work remains.
export const runHistoryImportStep = async (
  payload: HistoryImportPayload,
  logger: Logger,
  {
    client = applicationClient(),
    enqueue = enqueueHistoryImport,
    enqueueMedia = enqueueMediaImports,
  }: HistoryImportDependencies = {},
): Promise<HistoryImportStepResult> => {
  const { runToken } = payload ?? {};
  const pageSeq = Number.isSafeInteger(payload?.pageSeq) ? (payload.pageSeq as number) : undefined;

  if (!isUuid(runToken)) {
    return { status: 'idle' };
  }

  const startedAt = Date.now();
  const claimed = await bridgePost<HistoryImportPage | { stale: true } | { done: true }>(
    '/history/imports/claim',
    { runToken, ...(pageSeq !== undefined ? { pageSeq } : {}) },
    30_000,
  );

  if (!('leaseId' in claimed)) {
    logger.info('History import chain ended', { reason: 'done' in claimed ? 'done' : 'superseded' });
    return { status: 'idle' };
  }

  const page = claimed;
  const counter = { requests: 0 };
  let step: ChainStep;
  let result: HistoryImportStepResult;

  try {
    const imported = await importPage(countRequests(client, counter), page);

    if (imported.media.length > 0) {
      // Files upload in their own jobs, so the chain never waits behind them.
      await enqueueMedia(imported.media).catch(async (error: unknown) => {
        logger.warn('Could not queue media imports, importing them now', { error: String(error) });
        await attachMedia(client, imported.media, Date.now() + INLINE_MEDIA_TIME_BUDGET_MS);
      });
    }

    const nextRunInMs = paceDelay(counter.requests, Date.now() - startedAt);
    step = await bridgePost<ChainStep>('/history/imports/complete', {
      leaseId: page.leaseId,
      imported: imported.importedByChat,
      nextRunInMs,
    });

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
    const nextRunInMs = retryAfterMs ?? RETRY_DELAY_MS;
    logger.warn('Could not import history page', {
      chats: page.chats.map((chat) => chat.chatId),
      rateLimited: retryAfterMs !== undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    // Rate limiting is not the chats' fault, so it does not count toward setting them aside.
    step = await bridgePost<ChainStep>('/history/imports/release', {
      leaseId: page.leaseId,
      failed: retryAfterMs === undefined,
      nextRunInMs,
    });
    result = { status: 'failed', remaining: step.remaining, nextRunInMs };
  }

  if (result.remaining > 0) {
    // If this fails, the bridge replaces the chain once the scheduled run is overdue.
    const position =
      step.pageSeq !== undefined && step.nextJobKey ? { pageSeq: step.pageSeq, jobKey: step.nextJobKey } : undefined;
    await enqueue(runToken, result.nextRunInMs, position).catch((error: unknown) =>
      logger.error('Could not schedule the next history page', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return result;
};
