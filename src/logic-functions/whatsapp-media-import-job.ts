import { defineLogicFunction } from 'twenty-sdk/define';

import { MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { runMediaImport, type MediaImportPayload } from 'src/logic-functions/media-import';
import { createLogger } from 'src/logic-functions/utils/logger';

// One step of a media chain, started by the bridge's media queue and queued again by itself.
const handler = async (payload: MediaImportPayload) => runMediaImport(payload, createLogger('whatsapp-media-import'));

export default defineLogicFunction({
  universalIdentifier: MEDIA_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-media-import',
  description: 'Upload a few queued WhatsApp files, attach them in one request, then queue the next step.',
  timeoutSeconds: 300,
  handler,
});
