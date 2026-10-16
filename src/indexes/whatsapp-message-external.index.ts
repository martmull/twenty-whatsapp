import { defineIndex } from 'twenty-sdk/define';

import { MESSAGE_EXTERNAL_ID_FIELD_ID, WHATSAPP_MESSAGE_OBJECT_ID } from 'src/objects/whatsapp-message';

export default defineIndex({
  universalIdentifier: '3e5db2ac-4924-4610-9e1b-bf5e1aeadb39',
  objectUniversalIdentifier: WHATSAPP_MESSAGE_OBJECT_ID,
  isUnique: true,
  fields: [{ universalIdentifier: '99af3867-27eb-4226-8d7f-aae37a8fcfed', fieldUniversalIdentifier: MESSAGE_EXTERNAL_ID_FIELD_ID }],
});
