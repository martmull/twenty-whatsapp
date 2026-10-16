import { defineLogicFunction } from 'twenty-sdk/define';

import { MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { syncMessages } from 'src/logic-functions/message-data';
import { createLogger } from 'src/logic-functions/utils/logger';

// Queued by the bridge webhook. Concurrent runs are safe: the bridge leases each batch to one of them.
const handler = async () => syncMessages(createLogger('whatsapp-message-sync-job'));

export default defineLogicFunction({
  universalIdentifier: MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-message-sync-job',
  description: 'Import the WhatsApp messages queued by the bridge.',
  timeoutSeconds: 300,
  handler,
});
