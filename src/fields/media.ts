import { defineField, FieldType } from 'twenty-sdk/define';

import { MESSAGE_MEDIA_FIELD_ID, WHATSAPP_MESSAGE_OBJECT_ID } from 'src/constants/universal-identifiers';

export default defineField({
  universalIdentifier: MESSAGE_MEDIA_FIELD_ID,
  name: 'media',
  label: 'Media',
  type: FieldType.FILES,
  objectUniversalIdentifier: WHATSAPP_MESSAGE_OBJECT_ID,
  description: 'Imported WhatsApp images, videos, and audio.',
  universalSettings: { maxNumberOfValues: 1 },
});
