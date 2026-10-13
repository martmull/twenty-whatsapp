import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgeRequest } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';

const handler = async (event: RoutePayload) => {
  if (!event.userWorkspaceId) {
    throw new Error('Authentication required');
  }

  if (!(await canManageConnection())) {
    throw new Error('Only workspace administrators can disconnect WhatsApp');
  }

  return bridgeRequest('/disconnect');
};

export default defineLogicFunction({
  universalIdentifier: '7191eefe-4a5d-4942-bac9-53b41056bb24',
  name: 'whatsapp-connection-disconnect',
  timeoutSeconds: 15,
  httpRouteTriggerSettings: {
    path: '/whatsapp/connection/disconnect',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
