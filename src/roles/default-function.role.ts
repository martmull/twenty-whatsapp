import { defineApplicationRole, STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS, SystemPermissionFlag } from 'twenty-sdk/define';

import {
  WHATSAPP_ACCOUNT_OBJECT_ID,
  WHATSAPP_CONVERSATION_OBJECT_ID,
  WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID,
  WHATSAPP_MESSAGE_OBJECT_ID,
} from 'src/constants/universal-identifiers';

const appObject = (objectUniversalIdentifier: string) => ({
  objectUniversalIdentifier,
  canReadObjectRecords: true,
  canUpdateObjectRecords: true,
  canSoftDeleteObjectRecords: false,
  canDestroyObjectRecords: false,
});

export default defineApplicationRole({
  universalIdentifier: '50589f49-6cc1-414e-83d3-ec54751445ce',
  label: 'WhatsApp function role',
  description: 'Matches People by phone and stores WhatsApp accounts, conversations, and messages.',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  canBeAssignedToAgents: false,
  canBeAssignedToUsers: false,
  canBeAssignedToApiKeys: false,
  objectPermissions: [
    // Read only: People are created and renamed with the admin's own permissions.
    {
      objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: false,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    appObject(WHATSAPP_ACCOUNT_OBJECT_ID),
    appObject(WHATSAPP_CONVERSATION_OBJECT_ID),
    appObject(WHATSAPP_CONVERSATION_READ_STATE_OBJECT_ID),
    appObject(WHATSAPP_MESSAGE_OBJECT_ID),
  ],
  fieldPermissions: [],
  permissionFlagUniversalIdentifiers: [SystemPermissionFlag.UPLOAD_FILE],
});
