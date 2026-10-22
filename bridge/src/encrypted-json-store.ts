import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import type { Storage } from './storage.js';

type JsonCodec = {
  replacer?: (key: string, value: unknown) => unknown;
  reviver?: (key: string, value: unknown) => unknown;
};

// Keys hold phone numbers and chat IDs, so storage only sees a keyed hash of them.
const keyNameSecret = (encryptionKey: Buffer) =>
  Buffer.from(hkdfSync('sha256', encryptionKey, Buffer.alloc(0), 'twenty-whatsapp key names', 32));

// Each value is nonce (12 bytes) + GCM tag (16 bytes) + ciphertext, bound to its namespace and key.
const encrypt = (encryptionKey: Buffer, associatedData: Buffer, plaintext: Buffer): Buffer => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
};

const decrypt = (encryptionKey: Buffer, associatedData: Buffer, content: Buffer): Buffer => {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, content.subarray(0, 12));
  decipher.setAAD(associatedData);
  decipher.setAuthTag(content.subarray(12, 28));

  return Buffer.concat([decipher.update(content.subarray(28)), decipher.final()]);
};

// Stored names derive from the key, so a wrong key would otherwise just find nothing and start over.
export const verifyEncryptionKey = async (storage: Storage, encryptionKey: Buffer): Promise<void> => {
  const associatedData = Buffer.from('key-check');
  const check = await storage.read('key-check', 'check');

  if (!check) {
    await storage.write([
      { namespace: 'key-check', key: 'check', value: encrypt(encryptionKey, associatedData, Buffer.alloc(0)) },
    ]);
    return;
  }

  try {
    decrypt(encryptionKey, associatedData, check);
  } catch {
    throw new Error('WHATSAPP_SESSION_KEY does not match the key the stored session was encrypted with');
  }
};

export class EncryptedJsonStore<TValue> {
  private readonly nameSecret: Buffer;

  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
    private readonly encryptionKey: Buffer,
    private readonly codec: JsonCodec = {},
  ) {
    this.nameSecret = keyNameSecret(encryptionKey);
  }

  private storedKey(key: string): string {
    return createHmac('sha256', this.nameSecret).update(key).digest('hex');
  }

  private associatedData(storedKey: string): Buffer {
    return Buffer.from(`${this.namespace}\u0000${storedKey}`);
  }

  private decrypt(storedKey: string, content: Buffer): TValue {
    const plaintext = decrypt(this.encryptionKey, this.associatedData(storedKey), content);

    return JSON.parse(plaintext.toString('utf8'), this.codec.reviver) as TValue;
  }

  private encrypt(storedKey: string, value: TValue): Buffer {
    const plaintext = Buffer.from(JSON.stringify(value, this.codec.replacer), 'utf8');

    return encrypt(this.encryptionKey, this.associatedData(storedKey), plaintext);
  }

  async read(key: string): Promise<TValue | undefined> {
    const storedKey = this.storedKey(key);
    const content = await this.storage.read(this.namespace, storedKey);

    return content ? this.decrypt(storedKey, content) : undefined;
  }

  async write(key: string, value: TValue): Promise<void> {
    await this.writeMany([[key, value]]);
  }

  // Saves every entry or none; an undefined value deletes its key.
  async writeMany(entries: [key: string, value: TValue | undefined][]): Promise<void> {
    await this.storage.write(
      entries.map(([key, value]) => {
        const storedKey = this.storedKey(key);

        return {
          namespace: this.namespace,
          key: storedKey,
          value: value === undefined ? undefined : this.encrypt(storedKey, value),
        };
      }),
    );
  }

  async list(limit?: number): Promise<TValue[]> {
    return (await this.storage.list(this.namespace, limit)).map(({ key, value }) => this.decrypt(key, value));
  }

  async delete(key: string): Promise<void> {
    await this.writeMany([[key, undefined]]);
  }
}
