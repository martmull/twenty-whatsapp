import type { Logger } from 'src/logic-functions/utils/logger';

const ENQUEUE_RETRY_DELAYS_MS = [1_000, 3_000];

const sleep = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));

// Queues a chain's next job, retrying briefly: Twenty limits how many jobs an app may queue per
// minute, and a chain whose next job is never queued stops until the bridge replaces it.
export const enqueueWithRetry = async (
  enqueue: () => Promise<void>,
  logger: Logger,
  delaysMs: number[] = ENQUEUE_RETRY_DELAYS_MS,
): Promise<boolean> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await enqueue();
      return true;
    } catch (error) {
      if (attempt >= delaysMs.length) {
        logger.error('Could not queue the next job of the chain', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      await sleep(delaysMs[attempt]);
    }
  }
};
