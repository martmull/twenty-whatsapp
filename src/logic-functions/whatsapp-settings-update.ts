import { defineLogicFunction } from 'twenty-sdk/define';

import {
  bridgePost,
  getBridgeStatus,
  SETTINGS_BRIDGE_API_VERSION,
  type BridgeStatus,
} from 'src/logic-functions/bridge-request';
import { canManageConnection } from 'src/logic-functions/can-manage-connection';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';

const handler = route<{ createPeople?: boolean }>('whatsapp-settings-update', async (event, logger) => {
  requireUser(event);

  const createPeople = event.body?.createPeople;

  if (typeof createPeople !== 'boolean') {
    throw new HttpError(400, 'Invalid WhatsApp settings');
  }

  if (!(await canManageConnection())) {
    throw new HttpError(403, 'Only workspace administrators can change WhatsApp settings');
  }

  const status = await getBridgeStatus();

  if ((status.apiVersion ?? 1) < SETTINGS_BRIDGE_API_VERSION) {
    throw new HttpError(426, 'The running WhatsApp bridge is older than the app: restart it to load the update');
  }

  const settings = await bridgePost<Pick<BridgeStatus, 'createPeople'>>('/settings', { createPeople });
  logger.info('Updated WhatsApp settings', settings);
  return settings;
});

export default defineLogicFunction({
  universalIdentifier: '8b9c03e8-68d0-4041-8511-949cc2dd9c4b',
  name: 'whatsapp-settings-update',
  description: 'Choose whether saved WhatsApp contacts become People.',
  timeoutSeconds: 15,
  httpRouteTriggerSettings: {
    path: '/whatsapp/settings',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
