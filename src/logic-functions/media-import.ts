import type { CoreApiClient } from 'twenty-client-sdk/core';
import { enqueueJobs } from 'twenty-sdk/logic-function';

import { MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { bridgePost, reportRateLimit } from 'src/logic-functions/bridge-request';
import { enqueueWithRetry } from 'src/logic-functions/job-chain';
import { applicationClient } from 'src/logic-functions/message-data';
import { uploadMedia, type MediaItem, type MediaWrite } from 'src/logic-functions/message-media';
import { countingClient, rateLimitRetryAfterMs, upsertMessages } from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import { isEventId, isUuid } from 'src/logic-functions/utils/validators';

// Leaves room within the job timeout for the last upload and the attach request.
const UPLOAD_TIME_BUDGET_MS = 200_000;
const FAILURE_RETRY_DELAY_MS = 30_000;

export type MediaSource = 'live' | 'history';

// A file uploaded by an earlier attempt whose attach request failed: only the attach is retried.
type UploadedFile = { eventId: string; write: MediaWrite };

// `retries` counts the rate-limited attempts of one step, so each retry job gets its own ID.
export type MediaImportPayload = { runToken?: unknown; seq?: unknown; uploaded?: UploadedFile[]; retries?: number };

type ChainStep = { remaining: number; seq?: number; nextJobKey?: string; nextRunInMs?: number };
type MediaClaim =
  | { leaseId: string; seq: number; items: MediaItem[] }
  | { waitMs: number; seq: number; nextJobKey: string }
  | { stale: true }
  | { done: true };

type EnqueueMedia = (payload: MediaImportPayload, delayMs: number, jobId?: string) => Promise<void>;

export const mediaJobId = (runToken: string, jobKey: string) => `media.${runToken}.${jobKey}`;

const enqueueMediaJob: EnqueueMedia = async (payload, delayMs, jobId) => {
  await enqueueJobs({
    logicFunctionUniversalIdentifier: MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
    jobs: [{ payload, ...(jobId ? { jobId } : {}) }],
    delayMs,
  });
};

export const startMediaChains = async (runTokens: string[]): Promise<void> => {
  if (runTokens.length === 0) return;
  await enqueueJobs({
    logicFunctionUniversalIdentifier: MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
    jobs: runTokens.map((runToken) => ({ payload: { runToken, seq: 0 }, jobId: mediaJobId(runToken, '0') })),
  });
};

// Hands the files of written messages to the bridge's media queue, which starts the media job chains
// it needs. Never more than a few jobs, whatever the number of files.
export const queueMedia = async (
  items: MediaItem[],
  source: MediaSource,
  start: (runTokens: string[]) => Promise<void> = startMediaChains,
): Promise<void> => {
  if (items.length === 0) return;
  const { runTokens = [] } = await bridgePost<{ runTokens?: string[] }>('/media/queue', { items, source });
  await start(runTokens.filter(isUuid));
};

const isUploadedFile = (file: UploadedFile) =>
  isEventId(file?.eventId) &&
  isUuid(file.write?.id) &&
  Array.isArray(file.write.media) &&
  file.write.media.every((media) => isUuid(media?.fileId));

type MediaImportDependencies = {
  client?: CoreApiClient;
  enqueue?: EnqueueMedia;
  upload?: typeof uploadMedia;
};

export type MediaImportResult =
  | { status: 'idle' }
  | { status: 'waiting'; delayMs: number }
  | { status: 'imported'; attached: number; remaining: number }
  | { status: 'failed'; delayMs: number };

// One step of a media chain: claims a few files from the bridge, uploads them, attaches them in one
// upsert, then queues the chain's next step while files remain. Never throws: a failure gives the
// files back and queues the next step, so the chain survives it.
export const runMediaImport = async (
  payload: MediaImportPayload,
  logger: Logger,
  {
    client: baseClient = applicationClient(),
    enqueue = enqueueMediaJob,
    upload = uploadMedia,
  }: MediaImportDependencies = {},
): Promise<MediaImportResult> => {
  const runToken = payload?.runToken;
  const seq = Number.isSafeInteger(payload?.seq) ? (payload.seq as number) : undefined;
  if (!isUuid(runToken)) return { status: 'idle' };

  const next = (step: ChainStep, delayMs: number, extra: Partial<MediaImportPayload> = {}) =>
    step.remaining > 0 && step.seq !== undefined && step.nextJobKey
      ? enqueueWithRetry(
          () =>
            enqueue({ runToken, seq: step.seq, ...extra }, delayMs, mediaJobId(runToken, step.nextJobKey as string)),
          logger,
        )
      : Promise.resolve();

  const claim = await bridgePost<MediaClaim>('/media/claim', {
    runToken,
    ...(seq !== undefined ? { seq } : {}),
  }).catch((error: unknown) => {
    // The bridge replaces this chain once it is reachable again.
    logger.warn('Could not reach the bridge for media', { error: String(error) });
    return undefined;
  });

  if (!claim || 'stale' in claim || 'done' in claim) return { status: 'idle' };

  if ('waitMs' in claim) {
    await next({ remaining: 1, seq: claim.seq, nextJobKey: claim.nextJobKey }, claim.waitMs, {
      uploaded: payload.uploaded,
    });
    return { status: 'waiting', delayMs: claim.waitMs };
  }

  const startedAt = Date.now();
  const counter = { requests: 0 };
  const client = countingClient(baseClient, counter);
  const uploaded = (payload.uploaded ?? []).filter(isUploadedFile);
  const uploadedIds = new Set(uploaded.map((file) => file.eventId));
  const files: UploadedFile[] = [...uploaded];

  try {
    const toUpload = claim.items.filter((item) => !uploadedIds.has(item.eventId));
    const result = await upload(toUpload, Date.now() + UPLOAD_TIME_BUDGET_MS);
    const processed = toUpload.slice(0, result.processed);
    const writeById = new Map(result.writes.map((write) => [write.id, write]));
    for (const item of processed) {
      const write = writeById.get(item.messageId);
      if (write) files.push({ eventId: item.eventId, write });
    }

    if (files.length > 0) {
      await upsertMessages(
        client,
        files.map((file) => file.write),
      );
    }

    // Processed files include those WhatsApp no longer serves: the message keeps its kind, no file.
    const step = await bridgePost<ChainStep>('/media/complete', {
      leaseId: claim.leaseId,
      processed: [...new Set([...uploaded.map((file) => file.eventId), ...processed.map((item) => item.eventId)])],
      requests: counter.requests,
      elapsedMs: Date.now() - startedAt,
    });
    // The bridge spaces the steps to fit Twenty's job and API limits.
    await next(step, step.nextRunInMs ?? 0);
    logger.info('Imported media', { attached: files.length, remaining: step.remaining });
    return { status: 'imported', attached: files.length, remaining: step.remaining };
  } catch (error) {
    const retryAfterMs = rateLimitRetryAfterMs(error);

    if (retryAfterMs !== undefined) {
      // The lease is kept: the retry gets the same files back and only attaches what was uploaded.
      logger.warn('Twenty rate limited the media attach', { retryAfterMs });
      await reportRateLimit(retryAfterMs);
      const retries = (payload.retries ?? 0) + 1;
      await enqueueWithRetry(
        () =>
          enqueue(
            { runToken, seq: claim.seq, uploaded: files, retries },
            retryAfterMs,
            mediaJobId(runToken, `${claim.seq}-r${retries}`),
          ),
        logger,
      );
      return { status: 'failed', delayMs: retryAfterMs };
    }

    logger.warn('Could not import media', { error: error instanceof Error ? error.message : String(error) });
    const step = await bridgePost<ChainStep>('/media/release', {
      leaseId: claim.leaseId,
      failed: true,
      nextRunInMs: FAILURE_RETRY_DELAY_MS,
      requests: counter.requests,
    }).catch(() => undefined);
    if (step) await next(step, FAILURE_RETRY_DELAY_MS);
    return { status: 'failed', delayMs: FAILURE_RETRY_DELAY_MS };
  }
};
