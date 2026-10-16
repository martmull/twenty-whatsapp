import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgePost, type BridgeStatus } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';

const handler = route<{ ownsNumber?: boolean; acceptsRisk?: boolean }>('whatsapp-connection-start', async (event, logger) => {
  requireUser(event);

  if (event.body?.ownsNumber !== true || event.body?.acceptsRisk !== true) {
    throw new HttpError(400, 'Both acknowledgements are required');
  }

  if (!(await canManageConnection())) {
    throw new HttpError(403, 'Only workspace administrators can connect WhatsApp');
  }

  logger.info('Starting pairing');
  return { ...(await bridgePost<BridgeStatus>('/connect')), canManage: true };
});

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
