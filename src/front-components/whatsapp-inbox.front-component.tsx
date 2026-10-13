import { defineFrontComponent } from 'twenty-sdk/define';

import { INBOX_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { WhatsAppThread } from 'src/front-components/components/WhatsAppThread';

const WhatsAppInbox = () => <WhatsAppThread />;

export default defineFrontComponent({
  universalIdentifier: INBOX_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-inbox',
  description: 'WhatsApp conversations and manual replies.',
  component: WhatsAppInbox,
});
