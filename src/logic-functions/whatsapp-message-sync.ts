import { defineLogicFunction } from 'twenty-sdk/define';
import { enqueueJobs } from 'twenty-sdk/logic-function';

import { MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { syncMessages, type SyncResult } from 'src/logic-functions/live-sync';
import { syncConversationNames } from 'src/logic-functions/message-data';
import { syncReceipts } from 'src/logic-functions/receipt-sync';
import { createLogger, type Logger } from 'src/logic-functions/utils/logger';

export type MessageSyncPayload = { events?: boolean; names?: boolean; attempt?: number };

const RETRY_MIN_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 15 * 60_000;
// After this many runs without progress the chain stops; the next incoming message restarts it.
const MAX_ATTEMPTS_WITHOUT_PROGRESS = 8;

// Signals and a job's own follow-up use the bridge's key, so they fold into one job.
export const syncJobId = (jobKey: string | undefined) => (jobKey ? `sync.${jobKey}` : undefined);

const enqueueMessageSync = async (payload: MessageSyncPayload, delayMs: number, jobId?: string) => {
  await enqueueJobs({
    logicFunctionUniversalIdentifier: MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER,
    jobs: [{ payload, ...(jobId ? { jobId } : {}) }],
    delayMs,
  });
};

// While events remain, the job queues itself: at once after progress, after Twenty's delay when it
// rate limited the batch, and with a growing delay when a batch could not be imported (Twenty or
// the bridge failing, a chat that keeps erroring).
export const nextMessageSync = (result: SyncResult | undefined, attempt: number) => {
  if (result && !result.remaining) return undefined;
  if (result?.retryInMs !== undefined) return { attempt, delayMs: result.retryInMs };
  if (result && result.acknowledged > 0) return { attempt: 0, delayMs: 0 };
  if (attempt + 1 >= MAX_ATTEMPTS_WITHOUT_PROGRESS) return undefined;
  return { attempt: attempt + 1, delayMs: Math.min(RETRY_MIN_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS) };
};

export const runMessageSync = async (
  payload: MessageSyncPayload,
  logger: Logger,
  {
    sync = syncMessages,
    syncNames = syncConversationNames,
    syncDeliveryReceipts = syncReceipts,
    enqueue = enqueueMessageSync,
  } = {},
): Promise<SyncResult | undefined> => {
  let result: SyncResult | undefined;

  if (payload?.events) {
    try {
      result = await sync(logger);
    } catch (error) {
      logger.error('Message sync failed', { error: error instanceof Error ? error.message : String(error) });
    }

    // Receipts ride on the same signal and job: the bridge signals events when one arrives.
    const receipts = await syncDeliveryReceipts(logger).catch((error: unknown) => {
      logger.warn('Could not sync receipts', { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    });

    const next =
      nextMessageSync(result, payload.attempt ?? 0) ??
      (receipts?.remaining ? { attempt: payload.attempt ?? 0, delayMs: 0 } : undefined);
    if (next) {
      await enqueue({ events: true, attempt: next.attempt }, next.delayMs, syncJobId(result?.jobKey)).catch(
        (error: unknown) =>
          logger.error('Could not queue the next message sync', {
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }
  }

  if (payload?.names) {
    await syncNames(logger).catch((error) =>
      logger.warn('Could not sync conversation names', { error: String(error) }),
    );
  }

  return result;
};

// Queued by the bridge webhook, then by itself while events remain. Concurrent runs are safe: the
// bridge leases each batch to one of them.
const handler = async (payload: MessageSyncPayload) =>
  (await runMessageSync(payload, createLogger('whatsapp-message-sync'))) ?? {
    imported: 0,
    ignored: 0,
    acknowledged: 0,
    remaining: false,
  };

export default defineLogicFunction({
  universalIdentifier: MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-message-sync',
  description:
    'Import queued WhatsApp messages and delivery receipts, and refresh conversation names, when the bridge signals them.',
  timeoutSeconds: 300,
  handler,
});
