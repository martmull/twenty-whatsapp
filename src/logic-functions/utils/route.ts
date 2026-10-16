import type { RoutePayload } from 'twenty-sdk/define';
import { Response } from 'twenty-sdk/logic-function';

import { createLogger, type Logger } from 'src/logic-functions/utils/logger';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Wraps a route handler: logs every failure and answers with a JSON error and a meaningful status.
export const route = <TBody extends object>(
  name: string,
  handler: (event: RoutePayload<TBody>, logger: Logger) => Promise<unknown>,
) => async (event: RoutePayload<TBody>) => {
  const logger = createLogger(name);

  try {
    return await handler(event, logger);
  } catch (error) {
    if (error instanceof HttpError) {
      logger.warn(error.message, { status: error.status });
      return new Response({ error: error.message }, { status: error.status });
    }

    logger.error('Unexpected error', { error: error instanceof Error ? error.message : String(error) });
    return new Response({ error: 'Something went wrong' }, { status: 500 });
  }
};

export const requireUser = (event: RoutePayload<object>): string => {
  if (!event.userWorkspaceId) {
    throw new HttpError(401, 'Authentication required');
  }

  return event.userWorkspaceId;
};
