import { defineObject, FieldType, MetadataWritability } from 'twenty-sdk/define';

export const WHATSAPP_ACCOUNT_OBJECT_ID = '641ee68d-758d-420f-b96f-d18e237bcff9';
export const ACCOUNT_NAME_FIELD_ID = '9688b56a-45fe-4c48-9149-4ff115499020';
export const ACCOUNT_PHONE_FIELD_ID = '1ab3368d-31d0-4de6-84fb-65f6b6164b11';

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
    {
      universalIdentifier: ACCOUNT_NAME_FIELD_ID,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      icon: 'IconAbc',
    },
    { universalIdentifier: ACCOUNT_PHONE_FIELD_ID, type: FieldType.TEXT, name: 'phoneNumber', label: 'Phone number', icon: 'IconPhone' },
    { universalIdentifier: '64764075-77a0-49dc-b2d8-53ebff0bc46a', type: FieldType.TEXT, name: 'state', label: 'State', icon: 'IconStatusChange' },
    { universalIdentifier: '53c7aee5-b69a-49a3-adb5-974ff35f9c22', type: FieldType.DATE_TIME, name: 'acknowledgedAt', label: 'Acknowledged at', icon: 'IconCalendar' },
  ],
});
