import { defineFrontComponent } from 'twenty-sdk/define';
import { useSelectedRecordIds } from 'twenty-sdk/front-component';

import { PERSON_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { WhatsAppThread } from 'src/front-components/components/WhatsAppThread';

const WhatsAppPerson = () => {
  const selectedRecordIds = useSelectedRecordIds();
  const personId = selectedRecordIds.length === 1 ? selectedRecordIds[0] : undefined;

  return personId ? <WhatsAppThread personId={personId} /> : null;
};

export default defineFrontComponent({
  universalIdentifier: PERSON_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-person',
  description: 'WhatsApp activity and replies on a Person record.',
  component: WhatsAppPerson,
});
