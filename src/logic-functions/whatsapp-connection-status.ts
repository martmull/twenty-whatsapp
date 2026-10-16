import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { getBridgeStatus } from 'src/logic-functions/bridge-request';

const handler = async (event: RoutePayload) => {
  if (!event.userWorkspaceId) {
    throw new Error('Authentication required');
  }

  return getBridgeStatus();
};

export default defineLogicFunction({
  universalIdentifier: '700f736d-11f3-4ce2-a059-93865062e659',
  name: 'whatsapp-connection-status',
  timeoutSeconds: 15,
  httpRouteTriggerSettings: {
    path: '/whatsapp/connection/status',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
