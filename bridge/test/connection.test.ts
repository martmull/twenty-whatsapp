import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { proto, type Chat, type WAMessage } from '@whiskeysockets/baileys';

import { WhatsAppConnection, type ConnectionStatus } from '../src/connection.js';
import { createEncryptedAuthState } from '../src/encrypted-auth-state.js';
import type { MessageEvent } from '../src/message-event.js';

class RecordingConnection extends WhatsAppConnection {
  connectCount = 0;

  override async connect(): Promise<ConnectionStatus> {
    this.connectCount += 1;
    return { state: 'connected' };
  }
}

test('bridge waiters wake when new data is available', async () => {
  const connection = new WhatsAppConnection(join(tmpdir(), 'twenty-whatsapp-updates-test'), randomBytes(32));
  const initial = await connection.waitForChange('');
  assert.equal(initial.changed, true);

  const waiting = connection.waitForChange(initial.cursor);
  connection.notifyChange();
  const update = await waiting;
  assert.equal(update.changed, true);
  assert.notEqual(update.cursor, initial.cursor);
});

test('a sent message remains available for a recipient retry after bridge restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-retry-'));
  const encryptionKey = randomBytes(32);
  const chatId = '15551234567@s.whatsapp.net';
  let messageId = '';
  const connection = new WhatsAppConnection(directory, encryptionKey);

  try {
    Object.defineProperty(connection, 'socket', { value: {
      sendMessage: async (_jid: string, _content: unknown, options?: { messageId?: string }) => {
        messageId = options?.messageId ?? '';
        assert.ok(messageId);
        assert.equal((await connection.getSentMessage({ id: messageId }))?.conversation, 'Hello');
        return { key: { id: messageId, remoteJid: chatId, fromMe: true }, message: proto.Message.create({ conversation: 'Hello' }) };
      },
    } });
    Object.defineProperty(connection, 'status', { value: { state: 'connected', phoneNumber: '15557654321' } });

    assert.equal((await connection.sendText(randomUUID(), chatId, 'Hello', '+15557654321')).state, 'sent');
    const restarted = new WhatsAppConnection(directory, encryptionKey);
    assert.equal((await restarted.getSentMessage({ id: messageId, remoteJid: chatId }))?.conversation, 'Hello');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('only one importer claims a queued batch and completion wakes other viewers', async () => {
  class QueuedConnection extends WhatsAppConnection {
    override async getEvents(): Promise<MessageEvent[]> {
      return [{
        eventId: 'a'.repeat(64), chatId: '15551234567@s.whatsapp.net',
        providerMessageId: 'message-1', direction: 'inbound', text: 'Hello', sentAt: new Date().toISOString(),
      }];
    }
  }

  const connection = new QueuedConnection(join(tmpdir(), 'twenty-whatsapp-claim-test'), randomBytes(32));
  const claimed = await connection.claimEvents();
  assert.equal(claimed.events.length, 1);
  assert.ok(claimed.leaseId);
  assert.deepEqual(await connection.claimEvents(), { events: [] });

  const cursor = (await connection.waitForChange('')).cursor;
  const waiting = connection.waitForChange(cursor);
  assert.deepEqual(connection.releaseEvents(claimed.leaseId, true), { released: true });
  assert.equal((await waiting).changed, true);
  assert.ok((await connection.claimEvents()).leaseId);
});

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

test('contact name changes wake viewers and replace saved names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-name-updates-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const chatId = '15551234567@s.whatsapp.net';

  try {
    await connection.recordHistory([{ id: chatId, name: 'Alex' }], []);
    const cursor = (await connection.waitForChange('')).cursor;
    const waiting = connection.waitForChange(cursor);
    await connection.recordHistory([{ id: chatId, name: 'Alex Martin' }], []);

    assert.equal((await waiting).changed, true);
    assert.deepEqual(await connection.getHistoryNames([chatId]), [{ chatId, name: 'Alex Martin' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('numeric group titles resolve in the background and wake viewers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-group-name-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const chatId = '120363123456789012@g.us';

  try {
    await connection.recordHistory([], [], false, [{ id: chatId, name: chatId.split('@')[0] }]);
    Object.defineProperty(connection, 'socket', { value: { groupMetadata: async () => ({ subject: 'Family group' }) } });
    Object.defineProperty(connection, 'status', { value: { state: 'connected' } });
    const cursor = (await connection.waitForChange('')).cursor;
    const waiting = connection.waitForChange(cursor);

    assert.deepEqual(await connection.getHistoryNames([chatId]), [{ chatId, name: chatId.split('@')[0] }]);
    assert.equal((await waiting).changed, true);
    assert.deepEqual(await connection.getHistoryNames([chatId]), [{ chatId, name: 'Family group' }]);
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

test('group members use available contact names without inventing names for unknown members', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-members-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const groupId = '120363123456789012@g.us';
  let metadataCalls = 0;

  try {
    await connection.recordHistory([{ id: '15551234567@lid', lid: '15551234567@lid', jid: '15551234567@s.whatsapp.net', name: 'Alex Martin' }], [], false);
    Object.defineProperty(connection, 'socket', { value: { groupMetadata: async () => {
      metadataCalls += 1;
      return { participants: [
        { id: '15551234567@lid' },
        { id: '15557654321@lid' },
      ] };
    } } });
    Object.defineProperty(connection, 'status', { value: { state: 'connected' } });

    const members = await connection.getGroupMembers(groupId);
    assert.deepEqual(members, [
      { id: '15551234567@lid', phoneNumber: '+15551234567', displayName: 'Alex Martin', firstName: 'Alex', lastName: 'Martin' },
      { id: '15557654321@lid' },
    ]);
    assert.deepEqual(await connection.getGroupMembers(groupId), members);
    assert.equal(metadataCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing group titles are recovered from live metadata before review and import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-group-title-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const groupId = '120363123456789012@g.us';

  try {
    await connection.recordHistory([], [{
      key: { remoteJid: groupId, participant: '15551234567@s.whatsapp.net', id: 'group-title-1', fromMe: false },
      message: { conversation: 'Hello team' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }]);
    Object.defineProperty(connection, 'socket', { value: { groupMetadata: async () => ({ subject: 'Project team', participants: [] }) } });
    Object.defineProperty(connection, 'status', { value: { state: 'connected' } });

    assert.equal((await connection.getHistoryCandidates(30, 0, 20, 'group')).items[0].name, 'Project team');
    assert.equal((await connection.getHistoryMessages(groupId, 30, 0, 20)).name, 'Project team');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a group sender name can name the same direct contact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-direct-name-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const personId = '15551234567@s.whatsapp.net';

  try {
    await connection.recordHistory([], [{
      key: { remoteJid: personId, id: 'direct-1', fromMe: true },
      message: { conversation: 'Hello' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }, {
      key: { remoteJid: '120363123456789012@g.us', participant: personId, id: 'group-1', fromMe: false },
      pushName: 'Alex Martin',
      message: { conversation: 'Hi group' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }]);

    assert.equal((await connection.getHistoryCandidates(30, 0, 20, 'direct')).items[0].name, 'Alex Martin');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the linked number is identified as the current group member', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-self-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));

  try {
    Object.defineProperty(connection, 'socket', { value: {
      user: { id: '15551234567:4@s.whatsapp.net', lid: '777777777@lid' },
      groupMetadata: async () => ({ participants: [
        { id: '777777777@lid', jid: '15551234567@s.whatsapp.net' },
      ] }),
    } });
    Object.defineProperty(connection, 'status', { value: { state: 'connected', phoneNumber: '15551234567' } });

    assert.deepEqual(await connection.getGroupMembers('120363123456789012@g.us'), [
      { id: '777777777@lid', phoneNumber: '+15551234567', isMe: true },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('history candidates use the latest chat activity when messages are not captured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-order-'));
  const encryptionKey = randomBytes(32);
  const connection = new WhatsAppConnection(directory, encryptionKey);
  const olderId = '111111111111111111@g.us';
  const newerId = '999999999999999999@g.us';
  const olderTimestamp = 1_700_000_000;
  const newerTimestamp = olderTimestamp + 86_400;

  try {
    await connection.recordHistory([], [], true, [
      { id: olderId, name: 'Older group', conversationTimestamp: olderTimestamp } as Chat,
      { id: newerId, name: 'Newer group', lastMessageRecvTimestamp: newerTimestamp } as Chat,
    ]);

    const restored = new WhatsAppConnection(directory, encryptionKey);
    const firstPage = await restored.getHistoryCandidates(0, 0, 1, 'group');
    const secondPage = await restored.getHistoryCandidates(0, 1, 1, 'group');
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.items[0].chatId, newerId);
    assert.equal(firstPage.items[0].lastMessageAt, new Date(newerTimestamp * 1000).toISOString());
    assert.equal(secondPage.items[0].chatId, olderId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('image, video, and audio history stays ordered and exposes media details without decryption keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-media-order-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const olderId = '111111111111111111@g.us';
  const newerId = '999999999999999999@g.us';

  try {
    await connection.recordHistory([], [
      { key: { remoteJid: olderId, id: 'text-1', fromMe: false }, message: { conversation: 'Old text' }, messageTimestamp: 1_700_000_000 },
      { key: { remoteJid: newerId, id: 'image-1', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg', mediaKey: randomBytes(32), directPath: '/image', fileLength: 1024 } }, messageTimestamp: 1_700_086_400 },
      { key: { remoteJid: newerId, id: 'video-1', fromMe: true }, message: { videoMessage: { mimetype: 'video/mp4', caption: 'A short clip', mediaKey: randomBytes(32), directPath: '/video', fileLength: 2048 } }, messageTimestamp: 1_700_086_401 },
      { key: { remoteJid: newerId, id: 'audio-1', fromMe: false }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, mediaKey: randomBytes(32), directPath: '/audio', fileLength: 4096 } }, messageTimestamp: 1_700_086_402 },
    ]);

    const candidates = await connection.getHistoryCandidates(0, 0, 20, 'group');
    assert.equal(candidates.items[0].chatId, newerId);
    assert.equal(candidates.items[0].messageCount, 3);
    assert.equal(candidates.items[0].lastMessageAt, new Date(1_700_086_402_000).toISOString());
    const history = await connection.getHistoryMessages(newerId, 0, 0, 10);
    assert.equal(history.messages[0].text, '[Image]');
    assert.equal(history.messages[0].media?.kind, 'image');
    assert.equal(history.messages[0].media?.sizeBytes, 1024);
    assert.equal(history.nextOffset, 1);
    const nextPage = await connection.getHistoryMessages(newerId, 0, history.nextOffset, 10);
    assert.equal(nextPage.messages[0].text, 'A short clip');
    assert.equal(nextPage.messages[0].media?.kind, 'video');
    assert.equal(nextPage.messages[0].direction, 'outbound');
    const audioPage = await connection.getHistoryMessages(newerId, 0, nextPage.nextOffset ?? 0, 10);
    assert.equal(audioPage.messages[0].text, '[Audio]');
    assert.equal(audioPage.messages[0].media?.kind, 'audio');
    assert.equal(audioPage.messages[0].media?.mimeType, 'audio/ogg');
    assert.equal(audioPage.messages[0].media?.sizeBytes, 4096);
    assert.equal(JSON.stringify(history).includes('mediaKey'), false);
    const savedReferences = await readdir(join(directory, 'media-references'));
    assert.equal(savedReferences.length, 3);
    const encryptedReference = await readFile(join(directory, 'media-references', savedReferences[0]), 'utf8');
    assert.equal(encryptedReference.includes('/image'), false);
    assert.equal(encryptedReference.includes('/video'), false);
    assert.equal(encryptedReference.includes('/audio'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
