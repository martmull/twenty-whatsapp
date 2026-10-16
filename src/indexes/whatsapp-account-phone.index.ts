import { defineIndex } from 'twenty-sdk/define';

import { ACCOUNT_PHONE_FIELD_ID, WHATSAPP_ACCOUNT_OBJECT_ID } from 'src/objects/whatsapp-account';

export default defineIndex({
  universalIdentifier: '1de8e713-c376-4f6f-9ac3-6887d35d5da6',
  objectUniversalIdentifier: WHATSAPP_ACCOUNT_OBJECT_ID,
  isUnique: true,
  fields: [{ universalIdentifier: '3b212b55-1978-46df-82a5-b85d0cacdce2', fieldUniversalIdentifier: ACCOUNT_PHONE_FIELD_ID }],
});
