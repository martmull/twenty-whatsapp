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
  description: 'Matches People by phone, lets history import create them, and stores WhatsApp conversations.',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  canBeAssignedToAgents: false,
  canBeAssignedToUsers: false,
  canBeAssignedToApiKeys: false,
  objectPermissions: [
    // History import creates and renames People as the admin, which Twenty limits to what both this role
    // and the admin's own role allow.
    {
      objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
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
