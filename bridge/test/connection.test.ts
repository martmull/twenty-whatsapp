import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { WAMessage } from '@whiskeysockets/baileys';

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

test('history review is encrypted, deduplicated, date limited, and paged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-history-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const recent: WAMessage = {
    key: { remoteJid: '15551234567@s.whatsapp.net', id: 'recent-1', fromMe: false },
    message: { conversation: 'Private history text' },
    messageTimestamp: Math.floor(Date.now() / 1000) - 86_400,
  };
  const old: WAMessage = {
    key: { remoteJid: '15551234567@s.whatsapp.net', id: 'old-1', fromMe: true },
    message: { conversation: 'Older text' },
    messageTimestamp: Math.floor(Date.now() / 1000) - 40 * 86_400,
  };

  try {
    await connection.recordHistory([{ id: '15551234567@s.whatsapp.net', name: 'Alex' }], [recent, old], true);
    await connection.recordHistory([], [recent]);
    const thirtyDays = await connection.getHistoryCandidates(30, 0, 20);
    assert.equal(thirtyDays.total, 1);
    assert.equal(thirtyDays.items[0].messageCount, 1);
    assert.equal(thirtyDays.items[0].name, 'Alex');
    assert.ok(thirtyDays.historyReceivedAt);

    const all = await connection.getHistoryMessages('15551234567@s.whatsapp.net', 0, 0, 1);
    assert.equal(all.total, 2);
    assert.equal(all.nextOffset, 1);
    assert.equal(all.messages[0].text, 'Older text');
    assert.equal((await connection.getHistoryMessages('15551234567@s.whatsapp.net', 0, 1, 1)).messages[0].text, 'Private history text');

    const { readFile, readdir } = await import('node:fs/promises');
    const files = await readdir(join(directory, 'history-chats'));
    assert.equal((await readFile(join(directory, 'history-chats', files[0]))).includes(Buffer.from('Private history text')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
