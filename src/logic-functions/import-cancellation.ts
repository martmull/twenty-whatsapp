import { kv } from 'twenty-sdk/logic-function';

// Twenty cannot remove a queued job, so cancelling a history import records the job ID prefix of
// its chain here; every job of that chain checks it first and stops.
const CANCELLED_JOB_IDS_KEY = 'history-import.cancelled-job-ids';
const MAX_CANCELLED_CHAINS = 20;

export const historyChainJobIdPrefix = (runToken: string) => `history.${runToken}.`;

type CancellationStore = Pick<typeof kv, 'get' | 'set'>;

export const cancelHistoryJobs = async (runToken: string, store: CancellationStore = kv): Promise<void> => {
  const prefix = historyChainJobIdPrefix(runToken);
  const cancelled = (await store.get<string[]>(CANCELLED_JOB_IDS_KEY)) ?? [];
  await store.set(
    CANCELLED_JOB_IDS_KEY,
    [...cancelled.filter((item) => item !== prefix), prefix].slice(-MAX_CANCELLED_CHAINS),
  );
};

// A store that cannot be read counts as nothing cancelled: the bridge stops cancelled chains too.
export const isHistoryJobCancelled = async (jobId: string, store: CancellationStore = kv): Promise<boolean> => {
  const cancelled = await store.get<string[]>(CANCELLED_JOB_IDS_KEY).catch(() => null);
  return Array.isArray(cancelled) && cancelled.some((prefix) => jobId.startsWith(prefix));
};
