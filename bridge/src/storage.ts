// Encrypted entries of one tenant, grouped by namespace (one per store). Keys arrive already hashed.
export type StoredEntry = {
  namespace: string;
  key: string;
  // Undefined deletes the entry.
  value: Buffer | undefined;
};

export type Storage = {
  read(namespace: string, key: string): Promise<Buffer | undefined>;
  list(namespace: string, limit?: number): Promise<{ key: string; value: Buffer }[]>;
  // Applies every entry or none.
  write(entries: StoredEntry[]): Promise<void>;
  clear(): Promise<void>;
};
