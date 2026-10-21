import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

import pg from 'pg';

import { EncryptedJsonStore } from '../src/encrypted-json-store.js';
import { migrate, PostgresStorage } from '../src/postgres-storage.js';
import type { Storage } from '../src/storage.js';

import { MemoryStorage } from './memory-storage.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
after(() => pool?.end());

const backends: [string, () => Promise<Storage>][] = [
  ['memory', async () => new MemoryStorage()],
  [
    'postgres',
    async () => {
      await migrate(pool!);
      return new PostgresStorage(pool!, randomUUID());
    },
  ],
];

for (const [name, create] of backends) {
  const skip = name === 'postgres' && !pool ? 'set TEST_DATABASE_URL to run against Postgres' : false;

  test(`${name}: reads, lists, overwrites and deletes entries`, { skip }, async () => {
    const storage = await create();
    const store = new EncryptedJsonStore<{ text: string }>(storage, 'events', randomBytes(32));

    await store.write('15551234567@s.whatsapp.net', { text: 'first' });
    await store.write('15551234567@s.whatsapp.net', { text: 'second' });
    await store.write('15557654321@s.whatsapp.net', { text: 'other' });

    assert.deepEqual(await store.read('15551234567@s.whatsapp.net'), { text: 'second' });
    assert.equal(await store.read('15550000000@s.whatsapp.net'), undefined);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.list(1)).length, 1);

    await store.delete('15551234567@s.whatsapp.net');
    assert.deepEqual(await store.list(), [{ text: 'other' }]);
  });

  test(`${name}: a batch keeps the last write of a key and applies deletes`, { skip }, async () => {
    const storage = await create();
    const store = new EncryptedJsonStore<number>(storage, 'auth', randomBytes(32));

    await store.writeMany([
      ['a', 1],
      ['b', 2],
    ]);
    await store.writeMany([
      ['a', 3],
      ['a', 4],
      ['b', undefined],
      ['c', 5],
    ]);

    assert.equal(await store.read('a'), 4);
    assert.equal(await store.read('b'), undefined);
    assert.deepEqual((await store.list()).sort(), [4, 5]);
  });

  test(`${name}: keys stay private and values cannot move between keys`, { skip }, async () => {
    const storage = await create();
    const key = randomBytes(32);
    const store = new EncryptedJsonStore<string>(storage, 'phone-numbers', key);

    await store.write('15551234567', 'Alex');
    const [entry] = await storage.list('phone-numbers');
    assert.equal(entry.key.includes('15551234567'), false);
    assert.equal(entry.value.includes(Buffer.from('Alex')), false);

    await storage.write([{ namespace: 'contact-names', key: entry.key, value: entry.value }]);
    await assert.rejects(new EncryptedJsonStore<string>(storage, 'contact-names', key).list());
    await storage.write([{ namespace: 'phone-numbers', key: 'swapped', value: entry.value }]);
    await assert.rejects(store.list());
  });

  test(`${name}: clearing removes only this tenant's entries`, { skip }, async () => {
    const storage = await create();
    const other = await create();
    const key = randomBytes(32);

    await new EncryptedJsonStore<string>(storage, 'events', key).write('a', 'mine');
    await new EncryptedJsonStore<string>(other, 'events', key).write('a', 'theirs');
    await storage.clear();

    assert.deepEqual(await new EncryptedJsonStore<string>(storage, 'events', key).list(), []);
    assert.deepEqual(await new EncryptedJsonStore<string>(other, 'events', key).list(), ['theirs']);
  });
}

test('migrations run once even when bridges start together', { skip: !pool && 'set TEST_DATABASE_URL' }, async () => {
  const results = await Promise.all([migrate(pool!), migrate(pool!), migrate(pool!)]);
  assert.ok(
    results.every((applied) => applied.length === 0) || results.filter((applied) => applied.length > 0).length === 1,
  );
  assert.deepEqual(await migrate(pool!), []);
});
