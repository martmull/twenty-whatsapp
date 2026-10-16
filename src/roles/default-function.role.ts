import { defineApplicationRole, STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS, SystemPermissionFlag } from 'twenty-sdk/define';

import { WHATSAPP_ACCOUNT_OBJECT_ID } from 'src/objects/whatsapp-account';
import { WHATSAPP_CONVERSATION_OBJECT_ID } from 'src/objects/whatsapp-conversation';
import { WHATSAPP_MESSAGE_OBJECT_ID } from 'src/objects/whatsapp-message';
import { WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID } from 'src/objects/whatsapp-conversation-read-state';

export default defineApplicationRole({
  universalIdentifier: '50589f49-6cc1-414e-83d3-ec54751445ce',
  label: 'WhatsApp function role',
  description: 'Matches or creates selected People and stores WhatsApp accounts, conversations, and messages.',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  canBeAssignedToAgents: false,
  canBeAssignedToUsers: false,
  canBeAssignedToApiKeys: false,
  objectPermissions: [
    {
      objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    ...[WHATSAPP_ACCOUNT_OBJECT_ID, WHATSAPP_CONVERSATION_OBJECT_ID, WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID, WHATSAPP_MESSAGE_OBJECT_ID].map((objectUniversalIdentifier) => ({
      objectUniversalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    })),
  ],
  fieldPermissions: [],
  permissionFlagUniversalIdentifiers: [SystemPermissionFlag.UPLOAD_FILE],
});
