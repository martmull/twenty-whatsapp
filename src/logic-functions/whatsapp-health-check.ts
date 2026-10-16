import { defineHealthCheck } from 'twenty-sdk/define';

import { getBridgeStatus } from 'src/logic-functions/bridge-request';

export default defineHealthCheck({
  universalIdentifier: 'da7d9057-296c-438e-ba1a-0808c300a133',
  name: 'whatsapp-health-check',
  timeoutSeconds: 10,
  handler: async () => {
    const status = await getBridgeStatus().catch(() => undefined);

    if (!status) {
      return {
        status: 'ERROR',
        title: 'WhatsApp bridge unreachable',
        description: 'Check that the bridge is running and its URL and token are set.',
      };
    }

    return status.state === 'connected' ? { status: 'OK' } : { status: 'WARNING', title: 'WhatsApp not connected' };
  },
});
