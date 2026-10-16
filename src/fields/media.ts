import { defineField, FieldType } from 'twenty-sdk/define';

import { WHATSAPP_MESSAGE_MEDIA_FIELD_ID } from 'src/constants/whatsapp-media-field';

export default defineField({
  universalIdentifier: WHATSAPP_MESSAGE_MEDIA_FIELD_ID,
  name: 'media',
  label: 'Media',
  type: FieldType.FILES,
  objectUniversalIdentifier: 'e31b65a9-bbb8-4f7c-ad0d-cd9b9701d98c',
  description: 'Imported WhatsApp images, videos, and audio.',
  universalSettings: { maxNumberOfValues: 1 },
});
