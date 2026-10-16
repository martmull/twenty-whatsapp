import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgeRequest } from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import { applicationClient } from 'src/logic-functions/message-data';

const handler = async (event: RoutePayload) => {
  if (!event.userWorkspaceId) {
    throw new Error('Authentication required');
  }

  if (!(await canManageConnection())) {
    throw new Error('Only workspace administrators can disconnect WhatsApp');
  }

  const status = await bridgeRequest('/status');
  const result = await bridgeRequest('/disconnect');
  const phoneNumber = status.phoneNumber ? `+${status.phoneNumber.replace(/\D/g, '')}` : undefined;

  if (phoneNumber) {
    const client = applicationClient();
    const accounts = await client.query({
      whatsappAccounts: {
        __args: { filter: { phoneNumber: { eq: phoneNumber } }, first: 1 },
        edges: { node: { id: true } },
      },
    });
    const accountId = accounts.whatsappAccounts?.edges?.[0]?.node?.id;

    if (accountId) {
      await client.mutation({
        updateWhatsappAccount: { __args: { id: accountId, data: { state: 'disconnected' } }, id: true },
      });
    }
  }

  return result;
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
