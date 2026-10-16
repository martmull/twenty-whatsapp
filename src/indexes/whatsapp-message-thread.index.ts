import { defineIndex } from 'twenty-sdk/define';

import {
  MESSAGE_CONVERSATION_FIELD_ID,
  MESSAGE_SENT_AT_FIELD_ID,
  WHATSAPP_MESSAGE_OBJECT_ID,
} from 'src/constants/universal-identifiers';

// Loading a thread: messages of one conversation, newest first.
export default defineIndex({
  universalIdentifier: 'ddffb6ca-63a0-44e6-bd0d-8c43fdec0ea6',
  objectUniversalIdentifier: WHATSAPP_MESSAGE_OBJECT_ID,
  fields: [
    {
      universalIdentifier: '62cc7121-f6ad-4273-80c9-a647c877f698',
      fieldUniversalIdentifier: MESSAGE_CONVERSATION_FIELD_ID,
    },
    { universalIdentifier: '0c93c093-434a-43b9-95c1-1524786d01ca', fieldUniversalIdentifier: MESSAGE_SENT_AT_FIELD_ID },
  ],
});
