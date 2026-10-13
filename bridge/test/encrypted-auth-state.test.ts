import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEncryptedAuthState } from '../src/encrypted-auth-state.js';

test('session credentials survive restart and are encrypted at rest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-auth-'));
  const key = randomBytes(32);

  try {
    const first = await createEncryptedAuthState(directory, key);
    const registrationId = first.state.creds.registrationId;

    await first.saveCreds();

    const files = await readdir(directory);
    assert.equal(files.length, 1);

    const ciphertext = await readFile(join(directory, files[0]));
    assert.equal(ciphertext.includes(Buffer.from('registrationId')), false);

    const restored = await createEncryptedAuthState(directory, key);
    assert.equal(restored.state.creds.registrationId, registrationId);

    await assert.rejects(
      createEncryptedAuthState(directory, randomBytes(32)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
