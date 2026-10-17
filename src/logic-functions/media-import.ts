import { createHash } from 'node:crypto';

import type { CoreApiClient } from 'twenty-client-sdk/core';
import { enqueueJobs } from 'twenty-sdk/logic-function';

import { MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { bridgePost, reportRateLimit } from 'src/logic-functions/bridge-request';
import { applicationClient } from 'src/logic-functions/message-data';
import { uploadMedia, type MediaItem, type MediaWrite } from 'src/logic-functions/message-media';
import { countingClient, rateLimitRetryAfterMs, upsertMessages } from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import { isEventId, isUuid } from 'src/logic-functions/utils/validators';

export const MEDIA_ITEMS_PER_JOB = 5;
const MAX_JOBS_PER_ENQUEUE = 200;
// Platform retries for a transient failure; their backoff starts at one second.
const MEDIA_JOB_RETRY_LIMIT = 3;
// Leaves room within the job timeout for the last upload and the attach request.
const UPLOAD_TIME_BUDGET_MS = 200_000;
const BRIDGE_RETRY_MIN_DELAY_MS = 30_000;
const BRIDGE_RETRY_MAX_DELAY_MS = 15 * 60_000;
// Times the bridge may be unreachable before the files are given up on. Waiting for a free slot or
// for budget does not count.
const MAX_BRIDGE_FAILURES = 8;

export type MediaImportPayload = {
  items?: MediaItem[];
  // Files uploaded by an earlier attempt whose attach request failed: only the attach is retried.
  uploaded?: MediaWrite[];
  // Names each retry's job; failures counts the retries caused by an unreachable bridge.
  attempt?: number;
  failures?: number;
};

type EnqueueMedia = (payload: MediaImportPayload, delayMs: number, jobId: string) => Promise<void>;

// The same files always get the same job ID, so history and live sync never queue them twice.
export const mediaJobId = ({ items = [], uploaded = [], attempt = 0 }: MediaImportPayload): string => {
  const key = createHash('sha256')
    .update([...items.map((item) => item.eventId), ...uploaded.map((write) => write.id)].sort().join(','))
    .digest('hex')
    .slice(0, 40);
  return attempt > 0 ? `media.${key}.${attempt}` : `media.${key}`;
};

const enqueueMediaJob: EnqueueMedia = async (payload, delayMs, jobId) => {
  await enqueueJobs({
    logicFunctionUniversalIdentifier: MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
    jobs: [{ payload, jobId }],
    delayMs,
    retryLimit: MEDIA_JOB_RETRY_LIMIT,
  });
};

// A few files per job, each job named after its files.
export const mediaImportJobs = (items: MediaItem[]) => {
  const jobs: { payload: MediaImportPayload; jobId: string }[] = [];
  for (let index = 0; index < items.length; index += MEDIA_ITEMS_PER_JOB) {
    const group = items.slice(index, index + MEDIA_ITEMS_PER_JOB);
    jobs.push({ payload: { items: group }, jobId: mediaJobId({ items: group }) });
  }
  return jobs;
};

// Queues the files of imported messages in as few enqueue calls as possible.
export const enqueueMediaImports = async (items: MediaItem[]): Promise<number> => {
  const jobs = mediaImportJobs(items);

  for (let index = 0; index < jobs.length; index += MAX_JOBS_PER_ENQUEUE) {
    await enqueueJobs({
      logicFunctionUniversalIdentifier: MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
      jobs: jobs.slice(index, index + MAX_JOBS_PER_ENQUEUE),
      retryLimit: MEDIA_JOB_RETRY_LIMIT,
    });
  }

  return jobs.length;
};

const isMediaItem = (item: MediaItem) =>
  isUuid(item?.messageId) &&
  isEventId(item.eventId) &&
  typeof item.fileName === 'string' &&
  item.fileName.length > 0 &&
  item.fileName.length <= 255;

const isMediaWrite = (write: MediaWrite) =>
  isUuid(write?.id) && Array.isArray(write.media) && write.media.every((file) => isUuid(file?.fileId));

type MediaImportDependencies = {
  client?: CoreApiClient;
  enqueue?: EnqueueMedia;
  upload?: typeof uploadMedia;
};

export type MediaImportResult =
  | { status: 'imported'; attached: number; requeued: number }
  | { status: 'requeued'; delayMs: number }
  | { status: 'dropped' };

// Imports one group of files while holding one of the bridge's media leases, which limit how many
// downloads run at once. Throws on unexpected errors so the platform retries the job.
export const runMediaImport = async (
  payload: MediaImportPayload,
  logger: Logger,
  {
    client: baseClient = applicationClient(),
    enqueue = enqueueMediaJob,
    upload = uploadMedia,
  }: MediaImportDependencies = {},
): Promise<MediaImportResult> => {
  const counter = { requests: 0 };
  const client = countingClient(baseClient, counter);
  const items = (payload?.items ?? []).filter(isMediaItem);
  const uploaded = (payload?.uploaded ?? []).filter(isMediaWrite);
  const attempt = payload?.attempt ?? 0;
  const failures = payload?.failures ?? 0;
  const requeue = async (delayMs: number, next: MediaImportPayload = { items, uploaded }, failed = false) => {
    if (failed && failures + 1 >= MAX_BRIDGE_FAILURES) {
      logger.warn('Giving up on media files', { count: items.length + uploaded.length });
      return { status: 'dropped' as const };
    }
    const retry = { ...next, attempt: attempt + 1, failures: failed ? failures + 1 : failures };
    await enqueue(retry, delayMs, mediaJobId(retry));
    return { status: 'requeued' as const, delayMs };
  };

  if (items.length === 0 && uploaded.length === 0) {
    return { status: 'imported', attached: 0, requeued: 0 };
  }

  const claim = await bridgePost<{ leaseId?: string; waitMs?: number }>('/media/claim').catch(() => undefined);

  if (!claim) {
    return requeue(Math.min(BRIDGE_RETRY_MIN_DELAY_MS * 2 ** failures, BRIDGE_RETRY_MAX_DELAY_MS), undefined, true);
  }
  if (!claim.leaseId) {
    return requeue(claim.waitMs ?? BRIDGE_RETRY_MIN_DELAY_MS);
  }

  let writes: MediaWrite[] = uploaded;
  // Until the uploads report progress, every file is still to do.
  let rest: MediaItem[] = items;

  try {
    const result = await upload(items, Date.now() + UPLOAD_TIME_BUDGET_MS);
    writes = [...uploaded, ...result.writes];
    rest = items.slice(result.processed);

    if (writes.length > 0) {
      await upsertMessages(client, writes);
    }
  } catch (error) {
    const retryAfterMs = rateLimitRetryAfterMs(error);
    if (retryAfterMs === undefined) throw error;
    logger.warn('Twenty rate limited the media attach', { retryAfterMs });
    await reportRateLimit(retryAfterMs);
    return requeue(retryAfterMs, { items: rest, uploaded: writes });
  } finally {
    await bridgePost('/media/release', { leaseId: claim.leaseId, requests: counter.requests }).catch(() => undefined);
  }

  if (rest.length > 0) {
    await enqueue({ items: rest }, 0, mediaJobId({ items: rest }));
  }

  logger.info('Imported media', { attached: writes.length, requeued: rest.length });
  return { status: 'imported', attached: writes.length, requeued: rest.length };
};
