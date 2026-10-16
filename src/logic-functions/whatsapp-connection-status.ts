import { defineLogicFunction } from 'twenty-sdk/define';

import { getBridgeStatus } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import { requireUser, route } from 'src/logic-functions/utils/route';

const handler = route('whatsapp-connection-status', async (event) => {
  requireUser(event);

  const [status, canManage] = await Promise.all([getBridgeStatus(), canManageConnection()]);

  // Only admins may see the pairing QR code: whoever scans it links their WhatsApp account.
  return canManage
    ? { ...status, canManage }
    : { state: status.state, phoneNumber: status.phoneNumber, canManage };
});

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
