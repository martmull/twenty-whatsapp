import { defineField, FieldType } from 'twenty-sdk/define';

import { WHATSAPP_MESSAGE_OBJECT_ID } from 'src/constants/universal-identifiers';

export default defineField({
  universalIdentifier: '30e6da42-9be3-424a-8e4c-c70cdfd3c4cd',
  name: 'mediaKind',
  label: 'Media type',
  type: FieldType.SELECT,
  objectUniversalIdentifier: WHATSAPP_MESSAGE_OBJECT_ID,
  isNullable: true,
  options: [
    { value: 'IMAGE', label: 'Image', color: 'blue', position: 0 },
    { value: 'VIDEO', label: 'Video', color: 'purple', position: 1 },
    { value: 'AUDIO', label: 'Audio', color: 'orange', position: 2 },
    { value: 'DOCUMENT', label: 'Document', color: 'gray', position: 3 },
  ],
});
