import {
  ALL_WA_PATCH_NAMES,
  S_WHATSAPP_NET,
  decodePatches,
  decodeSyncdSnapshot,
  extractSyncdPatches,
  newLTHashState,
  proto,
  type ChatMutation,
  type SignalKeyStore,
  type WAPatchName,
  type WASocket,
} from '@whiskeysockets/baileys';

export type AddressBookEntry = {
  ids: string[];
  fullName: string;
  firstName: string;
  lastName: string;
};

// WhatsApp stores the saved full name and the given name; the last name is what remains.
export const splitContactName = (
  fullName: string,
  givenName?: string | null,
): { firstName: string; lastName: string } => {
  const full = fullName.trim().replace(/\s+/g, ' ');
  const first = givenName?.trim().replace(/\s+/g, ' ');

  if (first && full.toLowerCase().startsWith(`${first.toLowerCase()} `)) {
    return { firstName: first, lastName: full.slice(first.length + 1) };
  }
  if (first && full.toLowerCase().endsWith(` ${first.toLowerCase()}`)) {
    return { firstName: first, lastName: full.slice(0, -first.length - 1) };
  }
  if (first && first.toLowerCase() === full.toLowerCase()) {
    return { firstName: full, lastName: '' };
  }

  const [firstName = '', ...lastName] = full.split(' ');
  return { firstName, lastName: lastName.join(' ') };
};

export const toAddressBookEntry = ({ syncAction, index }: ChatMutation): AddressBookEntry | undefined => {
  const action = syncAction.value?.contactAction ?? syncAction.value?.lidContactAction;
  const fullName = (action?.fullName || action?.firstName)?.trim().slice(0, 120);
  if (!action || !fullName || /^\+?\d+$/.test(fullName)) {
    return undefined;
  }

  const { contactAction } = syncAction.value ?? {};
  const ids = [index[1], contactAction?.pnJid, contactAction?.lidJid].filter(
    (id): id is string => typeof id === 'string' && /^\d{7,15}@(?:s\.whatsapp\.net|lid)$/.test(id),
  );

  return ids.length > 0
    ? { ids: [...new Set(ids)], fullName, ...splitContactName(fullName, action.firstName?.slice(0, 80)) }
    : undefined;
};

export type AddressBookReport = {
  contacts: number;
  collections: Record<string, { records: number; contactRecords: number; error?: string }>;
};

const readCollection = async (
  socket: WASocket,
  name: WAPatchName,
  getAppStateSyncKey: (keyId: string) => Promise<proto.Message.IAppStateSyncKeyData | null | undefined>,
): Promise<ChatMutation[]> => {
  const mutations: Record<string, ChatMutation> = {};
  let state = newLTHashState();

  for (let page = 0; page < 20; page += 1) {
    const result = await socket.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'w:sync:app:state', type: 'set' },
      content: [
        {
          tag: 'sync',
          attrs: {},
          content: [
            {
              tag: 'collection',
              attrs: { name, version: state.version.toString(), return_snapshot: (!state.version).toString() },
            },
          ],
        },
      ],
    });
    const collection = (await extractSyncdPatches(result, {}))[name];
    if (!collection) {
      break;
    }

    if (collection.snapshot) {
      const decoded = await decodeSyncdSnapshot(name, collection.snapshot, getAppStateSyncKey, undefined);
      state = decoded.state;
      Object.assign(mutations, decoded.mutationMap);
    }
    if (collection.patches.length > 0) {
      const decoded = await decodePatches(name, collection.patches, state, getAppStateSyncKey, {}, undefined);
      state = decoded.state;
      Object.assign(mutations, decoded.mutationMap);
    }
    if (!collection.hasMorePatches) {
      break;
    }
  }

  return Object.values(mutations);
};

// Reads saved contacts without touching Baileys' stored app-state versions, so its own sync is unaffected.
// Every collection is read because WhatsApp does not document which one carries contacts.
export const fetchAddressBook = async (
  socket: WASocket,
  keys: SignalKeyStore,
): Promise<{ entries: AddressBookEntry[]; report: AddressBookReport }> => {
  const getAppStateSyncKey = async (keyId: string) => (await keys.get('app-state-sync-key', [keyId]))[keyId];
  const entries: AddressBookEntry[] = [];
  const report: AddressBookReport = { contacts: 0, collections: {} };

  for (const name of ALL_WA_PATCH_NAMES) {
    try {
      const mutations = await readCollection(socket, name, getAppStateSyncKey);
      const contacts = mutations.flatMap((mutation) => toAddressBookEntry(mutation) ?? []);
      entries.push(...contacts);
      report.collections[name] = {
        records: mutations.length,
        contactRecords: mutations.filter(
          ({ syncAction }) => syncAction.value?.contactAction || syncAction.value?.lidContactAction,
        ).length,
      };
    } catch (error) {
      report.collections[name] = {
        records: 0,
        contactRecords: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  report.contacts = entries.length;
  return { entries, report };
};
