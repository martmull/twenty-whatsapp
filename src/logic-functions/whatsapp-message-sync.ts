import { defineLogicFunction } from 'twenty-sdk/define';

import { MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { syncConversationNames, syncMessages } from 'src/logic-functions/message-data';
import { createLogger } from 'src/logic-functions/utils/logger';

export type MessageSyncPayload = { events?: boolean; names?: boolean };

// Queued by the bridge webhook. Concurrent runs are safe: the bridge leases each batch to one of them.
const handler = async (payload: MessageSyncPayload) => {
  const logger = createLogger('whatsapp-message-sync');
  const result = payload?.events ? await syncMessages(logger) : undefined;

  if (payload?.names) {
    await syncConversationNames(logger).catch((error) =>
      logger.warn('Could not sync conversation names', { error: String(error) }),
    );
  }

  return result ?? { imported: 0, ignored: 0 };
};

export default defineLogicFunction({
  universalIdentifier: MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-message-sync',
  description: 'Import queued WhatsApp messages and refresh conversation names when the bridge signals them.',
  timeoutSeconds: 300,
  handler,
});
