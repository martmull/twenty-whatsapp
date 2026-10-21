import pg from 'pg';

import type { Storage, StoredEntry } from './storage.js';

// Append only: a migration that ran on any database must never change.
const MIGRATIONS = [
  {
    name: '0001-entries',
    sql: `CREATE TABLE bridge_entries (
      tenant_id text NOT NULL,
      namespace text NOT NULL,
      key text NOT NULL,
      value bytea NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, namespace, key)
    )`,
  },
];

// Arbitrary, fixed ID: bridges starting together on an empty database take turns migrating it.
const MIGRATION_LOCK_ID = 727_202_001;

export const migrate = async (pool: pg.Pool): Promise<string[]> => {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS bridge_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ name: string }>('SELECT name FROM bridge_migrations');
    const done = new Set(rows.map((row) => row.name));

    for (const migration of MIGRATIONS.filter(({ name }) => !done.has(name))) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO bridge_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(migration.name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }

  return applied;
};

const UPSERT = `INSERT INTO bridge_entries (tenant_id, namespace, key, value)
  SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bytea[])
  ON CONFLICT (tenant_id, namespace, key) DO UPDATE SET value = excluded.value, updated_at = now()`;

const DELETE = `DELETE FROM bridge_entries
  WHERE tenant_id = $1 AND (namespace, key) IN (SELECT * FROM unnest($2::text[], $3::text[]))`;

export class PostgresStorage implements Storage {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
  ) {}

  async read(namespace: string, key: string): Promise<Buffer | undefined> {
    const { rows } = await this.pool.query<{ value: Buffer }>(
      'SELECT value FROM bridge_entries WHERE tenant_id = $1 AND namespace = $2 AND key = $3',
      [this.tenantId, namespace, key],
    );

    return rows[0]?.value;
  }

  async list(namespace: string, limit?: number): Promise<{ key: string; value: Buffer }[]> {
    // LIMIT NULL means no limit.
    const { rows } = await this.pool.query<{ key: string; value: Buffer }>(
      'SELECT key, value FROM bridge_entries WHERE tenant_id = $1 AND namespace = $2 ORDER BY key LIMIT $3',
      [this.tenantId, namespace, limit ?? null],
    );

    return rows;
  }

  async write(entries: StoredEntry[]): Promise<void> {
    // One upsert cannot touch a row twice, so the last write of a key wins.
    const latest = new Map(entries.map((entry) => [`${entry.namespace}\u0000${entry.key}`, entry]));
    const upserts = [...latest.values()].filter((entry) => entry.value);
    const deletes = [...latest.values()].filter((entry) => !entry.value);
    const statements = [
      ...(upserts.length > 0
        ? [
            {
              text: UPSERT,
              values: [
                this.tenantId,
                upserts.map((entry) => entry.namespace),
                upserts.map((entry) => entry.key),
                upserts.map((entry) => entry.value),
              ],
            },
          ]
        : []),
      ...(deletes.length > 0
        ? [
            {
              text: DELETE,
              values: [this.tenantId, deletes.map((entry) => entry.namespace), deletes.map((entry) => entry.key)],
            },
          ]
        : []),
    ];

    if (statements.length <= 1) {
      if (statements[0]) await this.pool.query(statements[0]);
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of statements) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM bridge_entries WHERE tenant_id = $1', [this.tenantId]);
  }
}
