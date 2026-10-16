import { defineLogicFunction } from 'twenty-sdk/define';

import { syncConversationNames, syncMessages } from 'src/logic-functions/message-data';
import { createLogger } from 'src/logic-functions/utils/logger';

const handler = async () => {
  const logger = createLogger('whatsapp-message-sync');
  const result = await syncMessages(logger);
  await syncConversationNames(logger).catch((error) =>
    logger.warn('Could not sync conversation names', { error: String(error) }));

  return result;
};

export default defineLogicFunction({
  universalIdentifier: '4353a880-c060-4b74-a96e-9dd03e387618',
  name: 'whatsapp-message-sync',
  description: 'Import new direct and selected-group messages, including available images, videos, and audio.',
  timeoutSeconds: 120,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/messages/sync',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  cronTriggerSettings: { pattern: '* * * * *' },
});
