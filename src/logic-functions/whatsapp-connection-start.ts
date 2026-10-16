import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgePost, type BridgeStatus } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';

const handler = async (event: RoutePayload<{ ownsNumber?: boolean; acceptsRisk?: boolean }>) => {
  if (!event.userWorkspaceId || event.body?.ownsNumber !== true || event.body?.acceptsRisk !== true) {
    throw new Error('Acknowledgement and authentication required');
  }

  if (!(await canManageConnection())) {
    throw new Error('Only workspace administrators can connect WhatsApp');
  }

  return bridgePost<BridgeStatus>('/connect');
};

export default defineLogicFunction({
  universalIdentifier: 'e51e904f-d3cc-4206-b02d-379d5320774c',
  name: 'whatsapp-connection-start',
  timeoutSeconds: 15,
  httpRouteTriggerSettings: {
    path: '/whatsapp/connection/start',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
