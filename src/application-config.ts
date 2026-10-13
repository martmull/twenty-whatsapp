import { defineApplication } from 'twenty-sdk/define';

import { APPLICATION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

export default defineApplication({
  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
  displayName: 'WhatsApp',
  description: 'Connect a WhatsApp linked device and bring conversations into Twenty.',
  applicationVariables: {
    WHATSAPP_BRIDGE_URL: {
      universalIdentifier: 'ba511fab-5b35-4e50-b8e8-36bb2db7c0e1',
      label: 'Bridge URL',
      description: 'Server-side URL of the persistent WhatsApp bridge.',
      isSecret: false,
    },
    WHATSAPP_BRIDGE_TOKEN: {
      universalIdentifier: '74c2fd2b-84cd-48d7-bcd9-65dd5ca9ff19',
      label: 'Bridge token',
      description: 'Shared token used by Twenty to authenticate to the bridge.',
      isSecret: true,
    },
  },
});
