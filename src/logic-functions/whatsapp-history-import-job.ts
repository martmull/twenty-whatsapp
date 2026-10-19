import { defineLogicFunction } from 'twenty-sdk/define';

import { HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { runHistoryImportStep, type HistoryImportPayload } from 'src/logic-functions/history-import';
import { createLogger } from 'src/logic-functions/utils/logger';

// An unexpected error is thrown so the platform retries the job: the bridge hands the same page
// back to the retry, and a retry of a page already imported stops at its claim.
const handler = async (payload: HistoryImportPayload) =>
  runHistoryImportStep(payload, createLogger('whatsapp-history-import-job'));

export default defineLogicFunction({
  universalIdentifier: HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-history-import-job',
  description: 'Import one page of selected WhatsApp history, then queue the next page at a paced delay.',
  timeoutSeconds: 300,
  handler,
});
