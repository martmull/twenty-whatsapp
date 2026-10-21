import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { createEncryptedAuthState } from '../src/encrypted-auth-state.js';
import { verifyEncryptionKey } from '../src/encrypted-json-store.js';

import { MemoryStorage } from './memory-storage.js';

test('session credentials survive restart and are encrypted at rest', async () => {
  const storage = new MemoryStorage();
  const key = randomBytes(32);

  const first = await createEncryptedAuthState(storage, key);
  const registrationId = first.state.creds.registrationId;

  await first.saveCreds();

  const stored = storage.stored('auth');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].includes(Buffer.from('registrationId')), false);

  const restored = await createEncryptedAuthState(storage, key);
  assert.equal(restored.state.creds.registrationId, registrationId);
});

test('a wrong encryption key is refused instead of starting a new session', async () => {
  const storage = new MemoryStorage();
  const key = randomBytes(32);

  await verifyEncryptionKey(storage, key);
  await verifyEncryptionKey(storage, key);
  await assert.rejects(verifyEncryptionKey(storage, randomBytes(32)), /does not match/);
});

test('a signal key update saves and deletes its keys together', async () => {
  const storage = new MemoryStorage();
  const key = randomBytes(32);
  const { state } = await createEncryptedAuthState(storage, key);
  const preKey = { public: randomBytes(32), private: randomBytes(32) };

  await state.keys.set({ 'pre-key': { '1': preKey, '2': preKey } });
  assert.deepEqual(Object.keys(await state.keys.get('pre-key', ['1', '2'])), ['1', '2']);

  await state.keys.set({ 'pre-key': { '1': null } });
  const keys = await state.keys.get('pre-key', ['1', '2']);
  assert.equal(keys['1'], null);
  assert.deepEqual(keys['2'], preKey);
  assert.equal(storage.stored('auth').length, 1);
});
