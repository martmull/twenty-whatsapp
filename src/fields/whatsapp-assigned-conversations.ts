import { defineField, FieldType, RelationType, STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';

import {
  CONVERSATION_ASSIGNEE_FIELD_ID,
  WHATSAPP_CONVERSATION_OBJECT_ID,
  WORKSPACE_MEMBER_CONVERSATIONS_FIELD_ID,
} from 'src/constants/universal-identifiers';

// The other side of a conversation's assignee: the conversations a member handles.
export default defineField({
  universalIdentifier: WORKSPACE_MEMBER_CONVERSATIONS_FIELD_ID,
  name: 'assignedWhatsappConversations',
  label: 'Assigned WhatsApp conversations',
  type: FieldType.RELATION,
  objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember.universalIdentifier,
  relationTargetObjectMetadataUniversalIdentifier: WHATSAPP_CONVERSATION_OBJECT_ID,
  relationTargetFieldMetadataUniversalIdentifier: CONVERSATION_ASSIGNEE_FIELD_ID,
  universalSettings: { relationType: RelationType.ONE_TO_MANY },
});
