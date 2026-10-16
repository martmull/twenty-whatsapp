import { defineLogicFunction } from 'twenty-sdk/define';

import { syncConversationNames, syncMessages } from 'src/logic-functions/message-data';
import { createLogger } from 'src/logic-functions/utils/logger';

// Safety net: the bridge webhook imports messages as they arrive, this catches anything it missed.
const handler = async () => {
  const logger = createLogger('whatsapp-message-sync');
  const result = await syncMessages(logger);
  await syncConversationNames(logger).catch((error) =>
    logger.warn('Could not sync conversation names', { error: String(error) }),
  );

  return result;
};

export default defineLogicFunction({
  universalIdentifier: '4353a880-c060-4b74-a96e-9dd03e387618',
  name: 'whatsapp-message-sync',
  description: 'Import queued WhatsApp messages and refresh conversation names.',
  timeoutSeconds: 120,
  handler,
  cronTriggerSettings: { pattern: '*/5 * * * *' },
});
