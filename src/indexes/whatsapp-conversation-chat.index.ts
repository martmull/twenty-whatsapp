import { defineIndex } from 'twenty-sdk/define';

import { CONVERSATION_ACCOUNT_ID_FIELD_ID, CONVERSATION_CHAT_ID_FIELD_ID, WHATSAPP_CONVERSATION_OBJECT_ID } from 'src/objects/whatsapp-conversation';

export default defineIndex({
  universalIdentifier: 'ad6fadb6-10f0-4046-899d-2cbadeb77e84',
  objectUniversalIdentifier: WHATSAPP_CONVERSATION_OBJECT_ID,
  isUnique: true,
  fields: [
    { universalIdentifier: '681d7f5e-1d53-43c5-a0d2-c5adf8d0965d', fieldUniversalIdentifier: CONVERSATION_ACCOUNT_ID_FIELD_ID },
    { universalIdentifier: 'fb23e2bd-c00c-4705-835c-4694329c994f', fieldUniversalIdentifier: CONVERSATION_CHAT_ID_FIELD_ID },
  ],
});
