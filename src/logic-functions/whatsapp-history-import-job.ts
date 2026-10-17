import { defineLogicFunction } from 'twenty-sdk/define';

import { HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { runHistoryImportStep } from 'src/logic-functions/history-import';
import { createLogger } from 'src/logic-functions/utils/logger';

// Never throws: a platform retry would start a second chain. Failures are retried by the next job.
const handler = async (payload: { runToken?: unknown }) => {
  const logger = createLogger('whatsapp-history-import-job');

  try {
    return await runHistoryImportStep(payload?.runToken, logger);
  } catch (error) {
    logger.error('History import step failed', { error: error instanceof Error ? error.message : String(error) });
    return { status: 'error' as const };
  }
};

export default defineLogicFunction({
  universalIdentifier: HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-history-import-job',
  description: 'Import one page of selected WhatsApp history, then queue the next page at a paced delay.',
  timeoutSeconds: 300,
  handler,
});
