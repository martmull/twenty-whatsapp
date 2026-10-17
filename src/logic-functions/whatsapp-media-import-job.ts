import { defineLogicFunction } from 'twenty-sdk/define';

import { MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { runMediaImport, type MediaImportPayload } from 'src/logic-functions/media-import';
import { createLogger } from 'src/logic-functions/utils/logger';

// Queued by message sync and history import for the files of the messages they wrote.
const handler = async (payload: MediaImportPayload) => runMediaImport(payload, createLogger('whatsapp-media-import'));

export default defineLogicFunction({
  universalIdentifier: MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-media-import',
  description: 'Upload the files of a few imported WhatsApp messages and attach them in one request.',
  timeoutSeconds: 300,
  handler,
});
