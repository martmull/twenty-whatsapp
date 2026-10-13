import { defineLogicFunction } from 'twenty-sdk/define';

import { syncInboundMessages } from 'src/logic-functions/message-data';

export default defineLogicFunction({
  universalIdentifier: '4353a880-c060-4b74-a96e-9dd03e387618',
  name: 'whatsapp-message-sync',
  description: 'Import new one-to-one text messages for matched People.',
  timeoutSeconds: 120,
  handler: syncInboundMessages,
  httpRouteTriggerSettings: {
    path: '/whatsapp/messages/sync',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  cronTriggerSettings: { pattern: '* * * * *' },
});
