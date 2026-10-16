import { defineIndex } from 'twenty-sdk/define';

import { MESSAGE_REQUEST_ID_FIELD_ID, WHATSAPP_MESSAGE_OBJECT_ID } from 'src/constants/universal-identifiers';

export default defineIndex({
  universalIdentifier: 'd0ff85f4-dafb-4306-b23c-cfa355abdb2b',
  objectUniversalIdentifier: WHATSAPP_MESSAGE_OBJECT_ID,
  isUnique: true,
  fields: [{ universalIdentifier: 'dbf3af5c-5da8-457c-92d4-6ea39a1a90f3', fieldUniversalIdentifier: MESSAGE_REQUEST_ID_FIELD_ID }],
});
