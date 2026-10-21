import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

import { EncryptedJsonStore } from './encrypted-json-store.js';
import type { Storage } from './storage.js';

export const createEncryptedAuthState = async (
  storage: Storage,
  encryptionKey: Buffer,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const store = new EncryptedJsonStore<unknown>(storage, 'auth', encryptionKey, {
    replacer: BufferJSON.replacer,
    reviver: BufferJSON.reviver,
  });
  const creds = ((await store.read('credentials')) as AuthenticationState['creds'] | undefined) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const values: Record<string, SignalDataTypeMap[typeof type]> = {};

          for (const id of ids) {
            let value = (await store.read(`${type}:${id}`)) ?? null;

            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }

            values[id] = value as SignalDataTypeMap[typeof type];
          }

          return values;
        },
        // One Signal update can touch several keys; saving them together keeps the session consistent.
        set: async (values) => {
          await store.writeMany(
            Object.entries(values).flatMap(([type, entries]) =>
              Object.entries(entries ?? {}).map(([id, value]): [string, unknown] => [
                `${type}:${id}`,
                value ?? undefined,
              ]),
            ),
          );
        },
      },
    },
    saveCreds: async () => store.write('credentials', creds),
  };
};
