import { defineApplicationRole } from 'twenty-sdk/define';

export default defineApplicationRole({
  universalIdentifier: '50589f49-6cc1-414e-83d3-ec54751445ce',
  label: 'WhatsApp function role',
  description: 'Connection routes do not require workspace record access.',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  canBeAssignedToAgents: false,
  canBeAssignedToUsers: false,
  canBeAssignedToApiKeys: false,
  objectPermissions: [],
  fieldPermissions: [],
  permissionFlagUniversalIdentifiers: [],
});
