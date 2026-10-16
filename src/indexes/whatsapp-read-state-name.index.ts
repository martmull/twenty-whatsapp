import { defineIndex } from 'twenty-sdk/define';

import { READ_STATE_NAME_FIELD_ID, WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID } from 'src/constants/universal-identifiers';

export default defineIndex({
  universalIdentifier: '9e5b8b03-7d0f-4c2a-abde-225e4050d420',
  objectUniversalIdentifier: WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID,
  isUnique: true,
  fields: [{ universalIdentifier: '9cd6c6a5-ba4d-4dbe-9437-744fefc1e109', fieldUniversalIdentifier: READ_STATE_NAME_FIELD_ID }],
});
