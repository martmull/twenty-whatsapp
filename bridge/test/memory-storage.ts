import type { Storage, StoredEntry } from '../src/storage.js';

export class MemoryStorage implements Storage {
  private readonly namespaces = new Map<string, Map<string, Buffer>>();

  async read(namespace: string, key: string): Promise<Buffer | undefined> {
    return this.namespaces.get(namespace)?.get(key);
  }

  async list(namespace: string, limit = Number.MAX_SAFE_INTEGER): Promise<{ key: string; value: Buffer }[]> {
    return [...(this.namespaces.get(namespace) ?? new Map<string, Buffer>())]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit)
      .map(([key, value]) => ({ key, value }));
  }

  async write(entries: StoredEntry[]): Promise<void> {
    for (const { namespace, key, value } of entries) {
      const values = this.namespaces.get(namespace) ?? new Map<string, Buffer>();
      this.namespaces.set(namespace, values);
      if (value) values.set(key, Buffer.from(value));
      else values.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.namespaces.clear();
  }

  // What actually reaches storage, to check it is encrypted.
  stored(namespace: string): Buffer[] {
    return [...(this.namespaces.get(namespace)?.values() ?? [])];
  }
}
