import { MetadataApiClient } from 'twenty-client-sdk/metadata';

export const canManageConnection = async (): Promise<boolean> => {
  const { currentUser } = await new MetadataApiClient().query({
    currentUser: { currentUserWorkspace: { permissionFlags: true } },
  });

  return (currentUser.currentUserWorkspace?.permissionFlags ?? []).includes('APPLICATIONS');
};
