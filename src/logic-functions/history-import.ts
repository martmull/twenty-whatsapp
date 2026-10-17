import type { CoreApiClient } from 'twenty-client-sdk/core';
import { enqueueJobs } from 'twenty-sdk/logic-function';

import { HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { bridgePost } from 'src/logic-functions/bridge-request';
import {
  applicationClient,
  isValidBridgeEvent,
  storeMessages,
  updateConversationSummary,
  type BridgeMessageEvent,
  type Conversation,
} from 'src/logic-functions/message-data';
import type { Logger } from 'src/logic-functions/utils/logger';
import { isUuid } from 'src/logic-functions/utils/validators';

// History import runs as a chain of jobs, one page per job, paced to stay well under Twenty's API
// rate limits (100 requests per minute per workspace by default) so live sync and the UI keep room.
export const HISTORY_IMPORT_REQUESTS_PER_MINUTE = 40;
const MEDIA_TIME_BUDGET_MS = 120_000;
const RETRY_DELAY_MS = 30_000;
const RATE_LIMITED_RETRY_DELAY_MS = 60_000;
// Each media file costs a createFileUpload and a completeFileUpload request.
const REQUESTS_PER_MEDIA_UPLOAD = 2;

type HistoryImportPage = {
  leaseId: string;
  chatId: string;
  conversationId: string;
  messages: BridgeMessageEvent[];
  isLastPage: boolean;
  summary?: { lastMessage?: BridgeMessageEvent; lastInboundAt?: string };
};

export type HistoryImportStepResult =
  | { status: 'idle' }
  | { status: 'imported'; imported: number; remaining: number; nextRunInMs: number }
  | { status: 'failed'; remaining: number; nextRunInMs: number };

export const isRateLimitError = (error: unknown): boolean => {
  const graphqlErrors = (error as { errors?: { extensions?: { code?: string } }[] } | undefined)?.errors;

  return (
    (Array.isArray(graphqlErrors) && graphqlErrors.some((item) => item?.extensions?.code === 'RATE_LIMITED')) ||
    (error instanceof Error && /too many requests|rate limit|limit reached/i.test(error.message))
  );
};

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

export const enqueueHistoryImport = async (runToken: string, delayMs: number): Promise<void> => {
  await enqueueJobs({
    logicFunctionUniversalIdentifier: HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
    jobs: [{ payload: { runToken } }],
    delayMs,
  });
};

const writeSummary = async (client: CoreApiClient, page: HistoryImportPage) => {
  const result = await client.query({
    whatsappConversations: {
      __args: { filter: { id: { eq: page.conversationId } }, first: 1 },
      edges: { node: { id: true, lastMessageAt: true, lastInboundAt: true } },
    },
  });
  const conversation = result.whatsappConversations?.edges?.[0]?.node as
    Pick<Conversation, 'id' | 'lastMessageAt' | 'lastInboundAt'> | undefined;

  if (conversation) {
    await updateConversationSummary(client, conversation, page.summary?.lastMessage, page.summary?.lastInboundAt);
  }
};

// Imports one page of queued history, then schedules the next job while work remains.
export const runHistoryImportStep = async (
  runToken: unknown,
  logger: Logger,
  { client = applicationClient(), enqueue = enqueueHistoryImport } = {},
): Promise<HistoryImportStepResult> => {
  if (!isUuid(runToken)) {
    return { status: 'idle' };
  }

  const startedAt = Date.now();
  const claimed = await bridgePost<HistoryImportPage | { stale: true } | { done: true }>(
    '/history/imports/claim',
    { runToken },
    30_000,
  );

  if (!('leaseId' in claimed)) {
    logger.info('History import chain ended', { reason: 'done' in claimed ? 'done' : 'superseded' });
    return { status: 'idle' };
  }

  const page = claimed;
  const counter = { requests: 0 };
  const countedClient = countRequests(client, counter);
  let result: HistoryImportStepResult;

  try {
    // Invalid events are skipped for good: reporting past them keeps the chain moving.
    const events = page.messages.filter((event) => event.chatId === page.chatId && isValidBridgeEvent(event));
    const stored = await storeMessages(countedClient, page.conversationId, events, startedAt + MEDIA_TIME_BUDGET_MS);
    const finishedPage = stored.lastProcessedEventId === events[events.length - 1]?.eventId;
    const lastEventId = finishedPage ? page.messages[page.messages.length - 1]?.eventId : stored.lastProcessedEventId;

    if (page.isLastPage && finishedPage) {
      await writeSummary(countedClient, page);
    }

    const requests = counter.requests + stored.mediaUploads * REQUESTS_PER_MEDIA_UPLOAD + 1;
    const nextRunInMs = paceDelay(requests, Date.now() - startedAt);
    const { remaining } = await bridgePost<{ remaining: number }>('/history/imports/complete', {
      leaseId: page.leaseId,
      lastEventId,
      imported: stored.imported,
      nextRunInMs,
    });

    logger.info('Imported history page', { chatId: page.chatId, imported: stored.imported, requests, remaining });
    result = { status: 'imported', imported: stored.imported, remaining, nextRunInMs };
  } catch (error) {
    const rateLimited = isRateLimitError(error);
    const nextRunInMs = rateLimited ? RATE_LIMITED_RETRY_DELAY_MS : RETRY_DELAY_MS;
    logger.warn('Could not import history page', {
      chatId: page.chatId,
      rateLimited,
      error: error instanceof Error ? error.message : String(error),
    });
    // Rate limiting is not the chat's fault, so it does not count toward setting the chat aside.
    const { remaining } = await bridgePost<{ remaining: number }>('/history/imports/release', {
      leaseId: page.leaseId,
      failed: !rateLimited,
      nextRunInMs,
    });
    result = { status: 'failed', remaining, nextRunInMs };
  }

  if (result.remaining > 0) {
    // If this fails, the bridge replaces the chain once the scheduled run is overdue.
    await enqueue(runToken, result.nextRunInMs).catch((error: unknown) =>
      logger.error('Could not schedule the next history page', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return result;
};
