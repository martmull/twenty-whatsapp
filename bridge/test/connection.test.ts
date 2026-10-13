import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WhatsAppConnection, type ConnectionStatus } from '../src/connection.js';
import { createEncryptedAuthState } from '../src/encrypted-auth-state.js';

class RecordingConnection extends WhatsAppConnection {
  connectCount = 0;

  override async connect(): Promise<ConnectionStatus> {
    this.connectCount += 1;
    return { state: 'connected' };
  }
}

test('bridge startup resumes only a saved linked device', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-resume-'));
  const encryptionKey = randomBytes(32);

  try {
    const connection = new RecordingConnection(directory, encryptionKey);
    await connection.resume();
    assert.equal(connection.connectCount, 0);

    const { state, saveCreds } = await createEncryptedAuthState(directory, encryptionKey);
    state.creds.me = { id: '1234567890@s.whatsapp.net' };
    await saveCreds();

    await connection.resume();
    assert.equal(connection.connectCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
