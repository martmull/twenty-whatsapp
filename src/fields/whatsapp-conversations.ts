import { defineField, FieldType, RelationType, STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';

import {
  CONVERSATION_PERSON_FIELD_ID,
  PERSON_CONVERSATIONS_FIELD_ID,
  WHATSAPP_CONVERSATION_OBJECT_ID,
} from 'src/constants/universal-identifiers';

export default defineField({
  universalIdentifier: PERSON_CONVERSATIONS_FIELD_ID,
  name: 'whatsappConversations',
  label: 'WhatsApp conversations',
  type: FieldType.RELATION,
  objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  relationTargetObjectMetadataUniversalIdentifier: WHATSAPP_CONVERSATION_OBJECT_ID,
  relationTargetFieldMetadataUniversalIdentifier: CONVERSATION_PERSON_FIELD_ID,
  universalSettings: { relationType: RelationType.ONE_TO_MANY },
});
