import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class EncryptedJsonStore<TValue> {
  constructor(
    private readonly directory: string,
    private readonly encryptionKey: Buffer,
  ) {}

  private pathFor(key: string): string {
    return join(this.directory, createHash('sha256').update(key).digest('hex'));
  }

  async read(key: string): Promise<TValue | undefined> {
    let content: Buffer;

    try {
      content = await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }

    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, content.subarray(0, 12));
    decipher.setAuthTag(content.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(content.subarray(28)), decipher.final()]).toString('utf8')) as TValue;
  }

  async write(key: string, value: TValue): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const destination = this.pathFor(key);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
    await rename(temporary, destination);
  }

  async list(limit: number): Promise<TValue[]> {
    let names: string[];

    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw error;
    }

    const values: TValue[] = [];

    for (const name of names.filter((entry) => /^[a-f\d]{64}$/.test(entry)).slice(0, limit)) {
      const content = await readFile(join(this.directory, name));
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, content.subarray(0, 12));
      decipher.setAuthTag(content.subarray(12, 28));
      values.push(JSON.parse(Buffer.concat([decipher.update(content.subarray(28)), decipher.final()]).toString('utf8')) as TValue);
    }

    return values;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
