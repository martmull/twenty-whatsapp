import { defineObject, FieldType, MetadataWritability, OnDeleteAction, RelationType, STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';

export const WHATSAPP_CONVERSATION_OBJECT_ID = '944b7d90-8835-42c3-bde8-b692191b2aa9';
export const CONVERSATION_NAME_FIELD_ID = 'c533b9d6-e078-4783-b76f-09e24467dc72';
export const CONVERSATION_CHAT_ID_FIELD_ID = 'cc94a7fc-9ee7-4e03-bec3-88f020256380';
export const CONVERSATION_ACCOUNT_ID_FIELD_ID = '32f55efa-0810-446c-808c-a464e7f61d8b';
export const CONVERSATION_PERSON_FIELD_ID = 'bc3ac292-9270-403b-9c07-30381d196909';
export const PERSON_CONVERSATIONS_FIELD_ID = '2e4fb193-37c9-4354-b5ae-0c036532aabe';

export default defineObject({
  universalIdentifier: WHATSAPP_CONVERSATION_OBJECT_ID,
  nameSingular: 'whatsappConversation',
  namePlural: 'whatsappConversations',
  labelSingular: 'WhatsApp Conversation',
  labelPlural: 'WhatsApp Conversations',
  icon: 'IconMessage',
  writability: MetadataWritability.APPLICATION,
  labelIdentifierFieldMetadataUniversalIdentifier: CONVERSATION_NAME_FIELD_ID,
  fields: [
    { universalIdentifier: '79bcb2f9-220d-426e-b38f-cab225ee288e', type: FieldType.TEXT, name: 'personId', label: 'Person ID', icon: 'IconUser', isUIEditable: false },
    {
      universalIdentifier: CONVERSATION_NAME_FIELD_ID,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      icon: 'IconAbc',
    },
    { universalIdentifier: CONVERSATION_CHAT_ID_FIELD_ID, type: FieldType.TEXT, name: 'chatId', label: 'Chat ID', icon: 'IconHash' },
    {
      universalIdentifier: CONVERSATION_PERSON_FIELD_ID,
      type: FieldType.RELATION,
      name: 'linkedPerson',
      label: 'Person',
      icon: 'IconUser',
      isNullable: true,
      isUIEditable: false,
      relationTargetObjectMetadataUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
      relationTargetFieldMetadataUniversalIdentifier: PERSON_CONVERSATIONS_FIELD_ID,
      universalSettings: { relationType: RelationType.MANY_TO_ONE, onDelete: OnDeleteAction.SET_NULL, joinColumnName: 'linkedPersonId' },
    },
    { universalIdentifier: CONVERSATION_ACCOUNT_ID_FIELD_ID, type: FieldType.TEXT, name: 'accountId', label: 'Account ID', icon: 'IconBrandWhatsapp' },
    { universalIdentifier: '4b32c71f-8c24-4429-8b16-05f6cd65ada6', type: FieldType.DATE_TIME, name: 'lastMessageAt', label: 'Last message at', icon: 'IconCalendar' },
    { universalIdentifier: '8161acfd-6177-4843-8e03-462ccf3b558b', type: FieldType.TEXT, name: 'lastPreview', label: 'Last preview', icon: 'IconMessage' },
  ],
});
