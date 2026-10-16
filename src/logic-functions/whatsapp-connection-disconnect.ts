import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgePost, getBridgeStatus, type BridgeStatus } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import { applicationClient } from 'src/logic-functions/message-data';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { digits } from 'src/logic-functions/utils/validators';

const handler = route('whatsapp-connection-disconnect', async (event, logger) => {
  requireUser(event);

  if (!(await canManageConnection())) {
    throw new HttpError(403, 'Only workspace administrators can disconnect WhatsApp');
  }

  const { phoneNumber } = await getBridgeStatus();
  const result = await bridgePost<BridgeStatus>('/disconnect');
  logger.info('Disconnected');

  if (phoneNumber) {
    const client = applicationClient();
    const accounts = await client.query({
      whatsappAccounts: {
        __args: { filter: { phoneNumber: { eq: `+${digits(phoneNumber)}` } }, first: 1 },
        edges: { node: { id: true } },
      },
    });
    const accountId = accounts.whatsappAccounts?.edges?.[0]?.node?.id;

    if (accountId) {
      await client.mutation({
        updateWhatsappAccount: { __args: { id: accountId, data: { state: 'DISCONNECTED' } }, id: true },
      });
    }
  }

  return { ...result, canManage: true };
});

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
