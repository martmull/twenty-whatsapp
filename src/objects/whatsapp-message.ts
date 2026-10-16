import { defineObject, FieldType, MetadataWritability } from 'twenty-sdk/define';

export const WHATSAPP_MESSAGE_OBJECT_ID = 'e31b65a9-bbb8-4f7c-ad0d-cd9b9701d98c';
export const MESSAGE_NAME_FIELD_ID = '5752cf20-abe9-4005-87d8-a1d11fb2fef4';
export const MESSAGE_EXTERNAL_ID_FIELD_ID = '255cc25e-ba6b-4a75-9072-10e2236b2cad';
export const MESSAGE_REQUEST_ID_FIELD_ID = '31427493-4117-4ce6-ba9e-e2e2ade40536';

export default defineObject({
  universalIdentifier: WHATSAPP_MESSAGE_OBJECT_ID,
  nameSingular: 'whatsappMessage',
  namePlural: 'whatsappMessages',
  labelSingular: 'WhatsApp Message',
  labelPlural: 'WhatsApp Messages',
  icon: 'IconMessage',
  writability: MetadataWritability.APPLICATION,
  labelIdentifierFieldMetadataUniversalIdentifier: MESSAGE_NAME_FIELD_ID,
  fields: [
    {
      universalIdentifier: MESSAGE_NAME_FIELD_ID,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      icon: 'IconAbc',
    },
    { universalIdentifier: '373b3555-cba8-4040-a4a4-77b819157853', type: FieldType.TEXT, name: 'conversationId', label: 'Conversation ID', icon: 'IconMessage' },
    { universalIdentifier: MESSAGE_EXTERNAL_ID_FIELD_ID, type: FieldType.TEXT, name: 'externalId', label: 'External ID', icon: 'IconHash' },
    { universalIdentifier: '2dfc5b8b-8a2a-4424-ac1d-f58a9ec39db5', type: FieldType.TEXT, name: 'direction', label: 'Direction', icon: 'IconArrowsLeftRight' },
    { universalIdentifier: '49a8f773-cbff-4f6f-abc6-3895d1654557', type: FieldType.TEXT, name: 'text', label: 'Text', icon: 'IconMessage' },
    { universalIdentifier: '4f9301ce-6bfa-4d8c-9cd7-3ffddfb64ead', type: FieldType.TEXT, name: 'senderId', label: 'Sender ID', icon: 'IconUser' },
    { universalIdentifier: 'd3f895b7-987b-4704-aea7-bdef4b504ad7', type: FieldType.TEXT, name: 'senderName', label: 'Sender name', icon: 'IconUser' },
    { universalIdentifier: 'e1c40db3-9f3d-4191-ac1f-236a48238d38', type: FieldType.DATE_TIME, name: 'sentAt', label: 'Sent at', icon: 'IconCalendar' },
    { universalIdentifier: 'dc5e694f-ac84-48e8-89c7-56f33d62af92', type: FieldType.TEXT, name: 'deliveryState', label: 'Delivery state', icon: 'IconStatusChange' },
    { universalIdentifier: MESSAGE_REQUEST_ID_FIELD_ID, type: FieldType.TEXT, name: 'requestId', label: 'Request ID', icon: 'IconHash' },
  ],
});
