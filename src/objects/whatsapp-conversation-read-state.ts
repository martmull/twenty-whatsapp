import { defineObject, FieldType, MetadataWritability } from 'twenty-sdk/define';

export const WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID = 'd6f8675d-d4d4-420f-8d20-39fd2dc73fdc';
export const READ_STATE_NAME_FIELD_ID =
  'f4a537ae-210d-4b2d-b0b7-e3f989ba4145';

export default defineObject({
  universalIdentifier: WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID,
  nameSingular: 'whatsappConversationReadState',
  namePlural: 'whatsappConversationReadStates',
  labelSingular: 'WhatsApp Conversation Read State',
  labelPlural: 'WhatsApp Conversation Read States',
  icon: 'IconMessage',
  writability: MetadataWritability.APPLICATION,
  labelIdentifierFieldMetadataUniversalIdentifier: READ_STATE_NAME_FIELD_ID,
  fields: [
    {
      universalIdentifier: READ_STATE_NAME_FIELD_ID,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      icon: 'IconAbc',
      isUnique: true,
      isUIEditable: false,
    },
    { universalIdentifier: '2919a936-55a7-4c9e-9174-d57c8367773b', type: FieldType.DATE_TIME, name: 'lastReadAt', label: 'Last read at', icon: 'IconCalendar', isUIEditable: false },
  ],
});
