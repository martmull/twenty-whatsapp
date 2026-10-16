import { defineObject, FieldType, MetadataWritability, RelationType } from 'twenty-sdk/define';

import {
  ACCOUNT_CONVERSATIONS_FIELD_ID,
  ACCOUNT_NAME_FIELD_ID,
  ACCOUNT_PHONE_FIELD_ID,
  CONVERSATION_ACCOUNT_FIELD_ID,
  WHATSAPP_ACCOUNT_OBJECT_ID,
  WHATSAPP_CONVERSATION_OBJECT_ID,
} from 'src/constants/universal-identifiers';

export default defineObject({
  universalIdentifier: WHATSAPP_ACCOUNT_OBJECT_ID,
  nameSingular: 'whatsappAccount',
  namePlural: 'whatsappAccounts',
  labelSingular: 'WhatsApp Account',
  labelPlural: 'WhatsApp Accounts',
  icon: 'IconBrandWhatsapp',
  writability: MetadataWritability.APPLICATION,
  labelIdentifierFieldMetadataUniversalIdentifier: ACCOUNT_NAME_FIELD_ID,
  fields: [
    { universalIdentifier: ACCOUNT_NAME_FIELD_ID, type: FieldType.TEXT, name: 'name', label: 'Name', icon: 'IconAbc' },
    {
      universalIdentifier: ACCOUNT_PHONE_FIELD_ID,
      type: FieldType.TEXT,
      name: 'phoneNumber',
      label: 'Phone number',
      icon: 'IconPhone',
    },
    {
      universalIdentifier: '0f1b36e0-ed72-436b-aa2e-6b0ce0c548f0',
      type: FieldType.SELECT,
      name: 'state',
      label: 'State',
      icon: 'IconStatusChange',
      isAuditLogged: false,
      options: [
        { value: 'CONNECTED', label: 'Connected', color: 'green', position: 0 },
        { value: 'DISCONNECTED', label: 'Disconnected', color: 'gray', position: 1 },
      ],
    },
    {
      universalIdentifier: '53c7aee5-b69a-49a3-adb5-974ff35f9c22',
      type: FieldType.DATE_TIME,
      name: 'acknowledgedAt',
      label: 'Acknowledged at',
      icon: 'IconCalendar',
    },
    {
      universalIdentifier: ACCOUNT_CONVERSATIONS_FIELD_ID,
      type: FieldType.RELATION,
      name: 'conversations',
      label: 'Conversations',
      icon: 'IconMessage',
      relationTargetObjectMetadataUniversalIdentifier: WHATSAPP_CONVERSATION_OBJECT_ID,
      relationTargetFieldMetadataUniversalIdentifier: CONVERSATION_ACCOUNT_FIELD_ID,
      universalSettings: { relationType: RelationType.ONE_TO_MANY },
    },
  ],
});
