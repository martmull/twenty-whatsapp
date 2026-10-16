import { defineObject, FieldType, MetadataReadability, MetadataWritability } from 'twenty-sdk/define';

import {
  READ_STATE_NAME_FIELD_ID,
  WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID,
} from 'src/constants/universal-identifiers';

// One record per member and conversation, named `<userWorkspaceId>:<conversationId>`.
// Only the app reads it: members never see who read what.
export default defineObject({
  universalIdentifier: WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID,
  nameSingular: 'whatsappConversationReadState',
  namePlural: 'whatsappConversationReadStates',
  labelSingular: 'WhatsApp Conversation Read State',
  labelPlural: 'WhatsApp Conversation Read States',
  icon: 'IconMessage',
  writability: MetadataWritability.APPLICATION,
  readability: MetadataReadability.APPLICATION,
  labelIdentifierFieldMetadataUniversalIdentifier: READ_STATE_NAME_FIELD_ID,
  fields: [
    {
      universalIdentifier: READ_STATE_NAME_FIELD_ID,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      icon: 'IconAbc',
    },
    {
      universalIdentifier: '2919a936-55a7-4c9e-9174-d57c8367773b',
      type: FieldType.DATE_TIME,
      name: 'lastReadAt',
      label: 'Last read at',
      icon: 'IconCalendar',
      isAuditLogged: false,
    },
  ],
});
