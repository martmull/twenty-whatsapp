import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

const encodeName = (name: string) =>
  createHash('sha256').update(name).digest('hex');

export const createEncryptedAuthState = async (
  directory: string,
  encryptionKey: Buffer,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const filePath = (name: string) => join(directory, encodeName(name));

  const read = async (name: string): Promise<unknown | null> => {
    let content: Buffer;

    try {
      content = await readFile(filePath(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    }

    const nonce = content.subarray(0, 12);
    const tag = content.subarray(12, 28);
    const ciphertext = content.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return JSON.parse(plaintext.toString('utf8'), BufferJSON.reviver) as unknown;
  };

  const write = async (name: string, value: unknown): Promise<void> => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const content = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    const destination = filePath(name);
    const temporary = `${destination}.${randomUUID()}.tmp`;

    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, destination);
  };

  const credentials = (await read('credentials')) as AuthenticationState['creds'] | null;
  const creds = credentials ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const values: Record<string, SignalDataTypeMap[typeof type]> = {};

          for (const id of ids) {
            let value = await read(`${type}:${id}`);

            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }

            values[id] = value as SignalDataTypeMap[typeof type];
          }

          return values;
        },
        set: async (values) => {
          for (const [type, entries] of Object.entries(values)) {
            if (!entries) {
              continue;
            }

            for (const [id, value] of Object.entries(entries)) {
              const name = `${type}:${id}`;

              if (value) {
                await write(name, value);
              } else {
                await rm(filePath(name), { force: true });
              }
            }
          }
        },
      },
    },
    saveCreds: async () => write('credentials', creds),
  };
};
