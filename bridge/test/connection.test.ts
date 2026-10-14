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

test('history uses the sender profile name when no saved contact name is available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-names-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));

  try {
    await connection.recordHistory([], [{
      key: { remoteJid: '15551234567@s.whatsapp.net', id: 'named-1', fromMe: false },
      pushName: 'Alex Martin',
      message: { conversation: 'Hello' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }]);

    const candidates = await connection.getHistoryCandidates(0, 0, 20);
    assert.equal(candidates.items[0].name, 'Alex Martin');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('group history keeps the group title and message sender', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-group-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const groupId = '120363123456789012@g.us';

  try {
    await connection.recordHistory([{ id: groupId, name: 'Project team' }], [{
      key: { remoteJid: groupId, participant: '15551234567@s.whatsapp.net', id: 'group-1', fromMe: false },
      pushName: 'Alex Martin',
      message: { conversation: 'Hello team' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }], true);

    const candidates = await connection.getHistoryCandidates(0, 0, 20);
    assert.equal(candidates.items[0].name, 'Project team');
    assert.equal(candidates.items[0].kind, 'group');
    assert.equal(candidates.items[0].messageCount, 1);
    assert.equal((await connection.getHistoryCandidates(0, 0, 20, 'group')).total, 1);
    assert.equal((await connection.getHistoryCandidates(0, 0, 20, 'direct')).total, 0);

    const history = await connection.getHistoryMessages(groupId, 0, 0, 20);
    assert.equal(history.messages[0].text, 'Hello team');
    assert.equal(history.messages[0].senderName, 'Alex Martin');
    assert.equal(history.messages[0].senderId, '15551234567@s.whatsapp.net');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
