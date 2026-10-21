import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { proto, type Chat, type WAMessage } from '@whiskeysockets/baileys';

import { ApiBudget } from '../src/api-budget.js';
import { WhatsAppConnection, type BridgeSignal, type ConnectionStatus } from '../src/connection.js';
import { createEncryptedAuthState } from '../src/encrypted-auth-state.js';
import type { MessageEvent } from '../src/message-event.js';

import { MemoryStorage } from './memory-storage.js';

class RecordingConnection extends WhatsAppConnection {
  connectCount = 0;

  override async connect(): Promise<ConnectionStatus> {
    this.connectCount += 1;
    return { state: 'connected' };
  }
}

const ACCOUNT_PHONE = '+15557654321';
const CHAT_ID = '15551234567@s.whatsapp.net';

type FakeSocketOptions = {
  upload?: () => Promise<{ mediaUrl: string; directPath: string }>;
  relay?: (message: proto.IMessage, messageId: string) => Promise<void>;
};

// Stands in for the Baileys socket: the real generateWAMessage builds and encrypts the payload.
const connectFakeSocket = (connection: WhatsAppConnection, { upload, relay }: FakeSocketOptions = {}) => {
  const calls = { uploads: 0, relays: [] as { jid: string; message: proto.IMessage; messageId: string }[] };
  Object.defineProperty(connection, 'socket', {
    value: {
      user: { id: '15557654321:7@s.whatsapp.net' },
      waUploadToServer: async () => {
        calls.uploads += 1;
        return upload ? upload() : { mediaUrl: 'https://mmg.whatsapp.net/media', directPath: '/media' };
      },
      relayMessage: async (jid: string, message: proto.IMessage, options: { messageId: string }) => {
        calls.relays.push({ jid, message, messageId: options.messageId });
        await relay?.(message, options.messageId);
        return options.messageId;
      },
    },
  });
  Object.defineProperty(connection, 'status', { value: { state: 'connected', phoneNumber: '15557654321' } });
  return calls;
};

const withConnection = async (
  run: (connection: WhatsAppConnection, storage: MemoryStorage, key: Buffer) => Promise<void>,
) => {
  const storage = new MemoryStorage();
  const encryptionKey = randomBytes(32);
  await run(new WhatsAppConnection(storage, encryptionKey), storage, encryptionKey);
};

const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const sendImage = (connection: WhatsAppConnection, requestId: string) =>
  connection.sendMedia(requestId, CHAT_ID, ACCOUNT_PHONE, 'image', 'image/png', 'photo.png', 'Look', PNG_PIXEL);

test('a sent message is available for a recipient retry before relaying and after a bridge restart', async () => {
  await withConnection(async (connection, storage, encryptionKey) => {
    const calls = connectFakeSocket(connection, {
      relay: async (_message, messageId) => {
        assert.ok(await connection.getSentMessage({ id: messageId }), 'payload stored before the relay');
      },
    });

    const receipt = await connection.sendText(randomUUID(), CHAT_ID, 'Hello', ACCOUNT_PHONE);
    assert.equal(receipt.state, 'sent');
    assert.equal(calls.relays[0].jid, CHAT_ID);
    const restarted = new WhatsAppConnection(storage, encryptionKey);
    const saved = await restarted.getSentMessage({ id: receipt.providerMessageId, remoteJid: CHAT_ID });
    assert.equal(saved?.conversation ?? saved?.extendedTextMessage?.text, 'Hello');
  });
});

test('an attachment is uploaded and sent once, and its payload is available for a recipient retry', async () => {
  await withConnection(async (connection, storage, encryptionKey) => {
    const calls = connectFakeSocket(connection, {
      relay: async (message, messageId) => {
        assert.equal(message.imageMessage?.caption, 'Look');
        assert.ok((await connection.getSentMessage({ id: messageId }))?.imageMessage);
      },
    });
    const requestId = randomUUID();

    assert.equal((await sendImage(connection, requestId)).state, 'sent');
    assert.equal((await sendImage(connection, requestId)).state, 'sent');
    assert.equal(calls.uploads, 1);
    assert.equal(calls.relays.length, 1);
    const restarted = new WhatsAppConnection(storage, encryptionKey);
    assert.ok((await restarted.getSentMessage({ id: calls.relays[0].messageId }))?.imageMessage?.mediaKey);
  });
});

test('a failed upload sent nothing, so retrying the same request sends the attachment', async () => {
  await withConnection(async (connection) => {
    let failUpload = true;
    const calls = connectFakeSocket(connection, {
      upload: async () => {
        if (failUpload) throw new Error('Upload timed out');
        return { mediaUrl: 'https://mmg.whatsapp.net/media', directPath: '/media' };
      },
    });
    const requestId = randomUUID();

    await assert.rejects(sendImage(connection, requestId), /Upload timed out/);
    assert.equal(calls.relays.length, 0);
    failUpload = false;
    assert.equal((await sendImage(connection, requestId)).state, 'sent');
    assert.equal(calls.relays.length, 1);
  });
});

test('a failed relay may have reached WhatsApp, so the request stays unknown instead of sending twice', async () => {
  await withConnection(async (connection) => {
    const calls = connectFakeSocket(connection, {
      relay: async () => {
        throw new Error('Connection closed');
      },
    });
    const requestId = randomUUID();

    await assert.rejects(sendImage(connection, requestId), /Connection closed/);
    assert.equal((await sendImage(connection, requestId)).state, 'unknown');
    assert.equal(calls.relays.length, 1);
  });
});

test('sends are relayed one at a time', async () => {
  await withConnection(async (connection) => {
    let active = 0;
    let maxActive = 0;
    connectFakeSocket(connection, {
      relay: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      },
    });

    const receipts = await Promise.all([
      sendImage(connection, randomUUID()),
      connection.sendText(randomUUID(), CHAT_ID, 'Second', ACCOUNT_PHONE),
      connection.sendText(randomUUID(), CHAT_ID, 'Third', ACCOUNT_PHONE),
    ]);
    assert.deepEqual(
      receipts.map((receipt) => receipt.state),
      ['sent', 'sent', 'sent'],
    );
    assert.equal(maxActive, 1);
  });
});

test('only one importer claims a queued batch at a time', async () => {
  class QueuedConnection extends WhatsAppConnection {
    override async getEvents(): Promise<MessageEvent[]> {
      return [
        {
          eventId: 'a'.repeat(64),
          chatId: '15551234567@s.whatsapp.net',
          providerMessageId: 'message-1',
          direction: 'inbound',
          text: 'Hello',
          sentAt: new Date().toISOString(),
        },
      ];
    }
  }

  const connection = new QueuedConnection(new MemoryStorage(), randomBytes(32));
  const claimed = await connection.claimEvents();
  assert.equal(claimed.events.length, 1);
  assert.ok(claimed.leaseId);
  const second = await connection.claimEvents();
  assert.deepEqual(second.events, []);
  assert.equal(second.leaseId, undefined);

  const released = await connection.releaseEvents(claimed.leaseId);
  assert.equal(released.released, true);
  assert.equal(released.remaining, false);
  assert.ok((await connection.claimEvents()).leaseId);
});

test('every claim moves the sync job key on, so a later signal gets its own job', async () => {
  const connection = new WhatsAppConnection(new MemoryStorage(), randomBytes(32));
  const before = connection.syncJobKey();
  const claimed = await connection.claimEvents();

  assert.notEqual(claimed.jobKey, before);
  assert.equal(connection.syncJobKey(), claimed.jobKey, 'signals sent now name the next job');
  assert.match(claimed.jobKey, /^[a-f\d]{8}\.\d+$/);
  assert.notEqual(
    new WhatsAppConnection(new MemoryStorage(), randomBytes(32)).syncJobKey(),
    before,
    'a restarted bridge does not reuse the keys of jobs Twenty still remembers',
  );
});

test('remembers the Twenty account of the linked number until it disconnects', async () => {
  const storage = new MemoryStorage();
  const encryptionKey = randomBytes(32);
  const accountId = '44444444-4444-4444-8444-444444444444';

  const connection = new WhatsAppConnection(storage, encryptionKey);
  connectFakeSocket(connection);
  assert.deepEqual(await connection.rememberTwentyAccount('+15550000000', accountId), { remembered: false });
  assert.deepEqual(await connection.rememberTwentyAccount(ACCOUNT_PHONE, accountId), { remembered: true });
  assert.equal(connection.getStatus().twentyAccountId, accountId);

  const restarted = new RecordingConnection(storage, encryptionKey);
  await restarted.resume();
  connectFakeSocket(restarted);
  assert.equal(restarted.getStatus().twentyAccountId, accountId);
});

test('releasing a batch reports remaining events to the sync instead of signaling Twenty again', async () => {
  const storage = new MemoryStorage();
  const signals: BridgeSignal[] = [];
  const connection = new WhatsAppConnection(storage, randomBytes(32), (signal) => signals.push(signal));
  const events = (connection as unknown as { events: { write: (key: string, value: MessageEvent) => Promise<void> } })
    .events;

  try {
    for (const id of ['a', 'b']) {
      await events.write(id.repeat(64), {
        eventId: id.repeat(64),
        chatId: '15551234567@s.whatsapp.net',
        providerMessageId: `message-${id}`,
        direction: 'inbound',
        text: 'Hello',
        sentAt: new Date().toISOString(),
      });
    }

    const first = await connection.claimEvents();
    await connection.ackEvents(['a'.repeat(64)]);
    assert.equal((await connection.releaseEvents(first.leaseId!)).remaining, true);

    const second = await connection.claimEvents();
    await connection.ackEvents(['b'.repeat(64)]);
    assert.equal((await connection.releaseEvents(second.leaseId!)).remaining, false);
    assert.deepEqual(signals, [], 'the Twenty job queues itself; the bridge does not signal again');
  } finally {
    await connection.disconnect();
  }
});

test('bridge startup resumes only a saved linked device', async () => {
  const storage = new MemoryStorage();
  const encryptionKey = randomBytes(32);

  const connection = new RecordingConnection(storage, encryptionKey);
  await connection.resume();
  assert.equal(connection.connectCount, 0);

  const { state, saveCreds } = await createEncryptedAuthState(storage, encryptionKey);
  state.creds.me = { id: '1234567890@s.whatsapp.net' };
  await saveCreds();

  await connection.resume();
  assert.equal(connection.connectCount, 1);
});

test('history review is encrypted, deduplicated, date limited, and paged', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
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
  assert.equal(
    (await connection.getHistoryMessages('15551234567@s.whatsapp.net', 0, 1, 1)).messages[0].text,
    'Private history text',
  );

  const [storedChat] = storage.stored('history-chats');
  assert.equal(storedChat.includes(Buffer.from('Private history text')), false);
});

test('history uses the sender profile name when no saved contact name is available', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));

  await connection.recordHistory(
    [],
    [
      {
        key: { remoteJid: '15551234567@s.whatsapp.net', id: 'named-1', fromMe: false },
        pushName: 'Alex Martin',
        message: { conversation: 'Hello' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  );

  const candidates = await connection.getHistoryCandidates(0, 0, 20);
  assert.equal(candidates.items[0].name, 'Alex Martin');
});

test('contact name changes replace saved names', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const chatId = '15551234567@s.whatsapp.net';

  await connection.recordHistory([{ id: chatId, name: 'Alex' }], []);
  await connection.recordHistory([{ id: chatId, name: 'Alex Martin' }], []);

  assert.deepEqual(await connection.getHistoryNames([chatId]), [{ chatId, name: 'Alex Martin' }]);
});

test('numeric group titles are replaced by the group subject before they are returned', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const groupIds = Array.from({ length: 8 }, (_, index) => `12036312345678901${index}@g.us`);
  let active = 0;
  let maxActive = 0;
  let metadataCalls = 0;

  await connection.recordHistory(
    [],
    [],
    false,
    groupIds.map((id) => ({ id, name: id.split('@')[0] })),
  );
  Object.defineProperty(connection, 'socket', {
    value: {
      groupMetadata: async (chatId: string) => {
        metadataCalls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { subject: `Group ${chatId.slice(-6, -5)}` };
      },
    },
  });
  Object.defineProperty(connection, 'status', { value: { state: 'connected' } });

  const names = await connection.getHistoryNames(groupIds);
  assert.deepEqual(
    names,
    groupIds.map((chatId) => ({ chatId, name: `Group ${chatId.slice(-6, -5)}` })),
  );
  assert.ok(maxActive <= 3, 'group metadata requests are rate limited');

  await connection.getHistoryNames(groupIds);
  assert.equal(metadataCalls, groupIds.length, 'resolved subjects are kept');
});

test('only saved contacts are reported, by phone number, for their LID or phone ID', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));

  await connection.recordAddressBook([
    { ids: ['15551234567@s.whatsapp.net'], fullName: 'Alex Martin', firstName: 'Alex', lastName: 'Martin' },
  ]);
  await connection.recordHistory(
    [
      { id: '777777777@lid', lid: '777777777@lid', jid: '15551234567@s.whatsapp.net' },
      { id: '15557654321@s.whatsapp.net', notify: 'Profile name only' },
    ],
    [],
  );

  assert.deepEqual(
    await connection.getSavedContacts(['777777777@lid', '15551234567@s.whatsapp.net', '15557654321@s.whatsapp.net']),
    [
      { id: '777777777@lid', phoneNumber: '+15551234567', firstName: 'Alex', lastName: 'Martin' },
      { id: '15551234567@s.whatsapp.net', phoneNumber: '+15551234567', firstName: 'Alex', lastName: 'Martin' },
    ],
  );
});

test('group members saved in the address book are flagged as saved contacts', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));

  await connection.recordAddressBook([
    { ids: ['15551234567@s.whatsapp.net'], fullName: 'Alex Martin', firstName: 'Alex', lastName: 'Martin' },
  ]);
  Object.defineProperty(connection, 'socket', {
    value: {
      groupMetadata: async () => ({
        participants: [{ id: '15551234567@s.whatsapp.net' }, { id: '15557654321@s.whatsapp.net', notify: 'Sam' }],
      }),
    },
  });
  Object.defineProperty(connection, 'status', { value: { state: 'connected' } });

  assert.deepEqual(await connection.getGroupMembers('120363123456789012@g.us'), [
    {
      id: '15551234567@s.whatsapp.net',
      phoneNumber: '+15551234567',
      displayName: 'Alex Martin',
      firstName: 'Alex',
      lastName: 'Martin',
      isSavedContact: true,
    },
    {
      id: '15557654321@s.whatsapp.net',
      phoneNumber: '+15557654321',
      displayName: 'Sam',
      firstName: 'Sam',
      lastName: '',
    },
  ]);
});

test('group history keeps the group title and message sender', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const groupId = '120363123456789012@g.us';

  await connection.recordHistory(
    [{ id: groupId, name: 'Project team' }],
    [
      {
        key: { remoteJid: groupId, participant: '15551234567@s.whatsapp.net', id: 'group-1', fromMe: false },
        pushName: 'Alex Martin',
        message: { conversation: 'Hello team' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
    true,
  );

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
});

test('group members use available contact names without inventing names for unknown members', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const groupId = '120363123456789012@g.us';
  let metadataCalls = 0;

  await connection.recordHistory(
    [{ id: '15551234567@lid', lid: '15551234567@lid', jid: '15551234567@s.whatsapp.net', name: 'Alex Martin' }],
    [],
    false,
  );
  Object.defineProperty(connection, 'socket', {
    value: {
      groupMetadata: async () => {
        metadataCalls += 1;
        return { participants: [{ id: '15551234567@lid' }, { id: '15557654321@lid' }] };
      },
    },
  });
  Object.defineProperty(connection, 'status', { value: { state: 'connected' } });

  const members = await connection.getGroupMembers(groupId);
  assert.deepEqual(members, [
    {
      id: '15551234567@lid',
      phoneNumber: '+15551234567',
      displayName: 'Alex Martin',
      firstName: 'Alex',
      lastName: 'Martin',
    },
    { id: '15557654321@lid' },
  ]);
  assert.deepEqual(await connection.getGroupMembers(groupId), members);
  assert.equal(metadataCalls, 1);
});

test('missing group titles are recovered from live metadata before review and import', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const groupId = '120363123456789012@g.us';

  await connection.recordHistory(
    [],
    [
      {
        key: { remoteJid: groupId, participant: '15551234567@s.whatsapp.net', id: 'group-title-1', fromMe: false },
        message: { conversation: 'Hello team' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  );
  Object.defineProperty(connection, 'socket', {
    value: { groupMetadata: async () => ({ subject: 'Project team', participants: [] }) },
  });
  Object.defineProperty(connection, 'status', { value: { state: 'connected' } });

  assert.equal((await connection.getHistoryCandidates(30, 0, 20, 'group')).items[0].name, 'Project team');
  assert.equal((await connection.getHistoryMessages(groupId, 30, 0, 20)).name, 'Project team');
});

test('a group sender name can name the same direct contact', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const personId = '15551234567@s.whatsapp.net';

  await connection.recordHistory(
    [],
    [
      {
        key: { remoteJid: personId, id: 'direct-1', fromMe: true },
        message: { conversation: 'Hello' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
      {
        key: { remoteJid: '120363123456789012@g.us', participant: personId, id: 'group-1', fromMe: false },
        pushName: 'Alex Martin',
        message: { conversation: 'Hi group' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  );

  assert.equal((await connection.getHistoryCandidates(30, 0, 20, 'direct')).items[0].name, 'Alex Martin');
});

test('the linked number is identified as the current group member', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));

  Object.defineProperty(connection, 'socket', {
    value: {
      user: { id: '15551234567:4@s.whatsapp.net', lid: '777777777@lid' },
      groupMetadata: async () => ({ participants: [{ id: '777777777@lid', jid: '15551234567@s.whatsapp.net' }] }),
    },
  });
  Object.defineProperty(connection, 'status', { value: { state: 'connected', phoneNumber: '15551234567' } });

  assert.deepEqual(await connection.getGroupMembers('120363123456789012@g.us'), [
    { id: '777777777@lid', phoneNumber: '+15551234567', isMe: true },
  ]);
});

test('history candidates use the latest chat activity when messages are not captured', async () => {
  const storage = new MemoryStorage();
  const encryptionKey = randomBytes(32);
  const connection = new WhatsAppConnection(storage, encryptionKey);
  const olderId = '111111111111111111@g.us';
  const newerId = '999999999999999999@g.us';
  const olderTimestamp = 1_700_000_000;
  const newerTimestamp = olderTimestamp + 86_400;

  await connection.recordHistory([], [], true, [
    { id: olderId, name: 'Older group', conversationTimestamp: olderTimestamp } as Chat,
    { id: newerId, name: 'Newer group', lastMessageRecvTimestamp: newerTimestamp } as Chat,
  ]);

  const restored = new WhatsAppConnection(storage, encryptionKey);
  const firstPage = await restored.getHistoryCandidates(0, 0, 1, 'group');
  const secondPage = await restored.getHistoryCandidates(0, 1, 1, 'group');
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.items[0].chatId, newerId);
  assert.equal(firstPage.items[0].lastMessageAt, new Date(newerTimestamp * 1000).toISOString());
  assert.equal(secondPage.items[0].chatId, olderId);
});

test('image, video, and audio history stays ordered and exposes media details without decryption keys', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const olderId = '111111111111111111@g.us';
  const newerId = '999999999999999999@g.us';

  await connection.recordHistory(
    [],
    [
      {
        key: { remoteJid: olderId, id: 'text-1', fromMe: false },
        message: { conversation: 'Old text' },
        messageTimestamp: 1_700_000_000,
      },
      {
        key: { remoteJid: newerId, id: 'image-1', fromMe: false },
        message: {
          imageMessage: { mimetype: 'image/jpeg', mediaKey: randomBytes(32), directPath: '/image', fileLength: 1024 },
        },
        messageTimestamp: 1_700_086_400,
      },
      {
        key: { remoteJid: newerId, id: 'video-1', fromMe: true },
        message: {
          videoMessage: {
            mimetype: 'video/mp4',
            caption: 'A short clip',
            mediaKey: randomBytes(32),
            directPath: '/video',
            fileLength: 2048,
          },
        },
        messageTimestamp: 1_700_086_401,
      },
      {
        key: { remoteJid: newerId, id: 'audio-1', fromMe: false },
        message: {
          audioMessage: {
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            mediaKey: randomBytes(32),
            directPath: '/audio',
            fileLength: 4096,
          },
        },
        messageTimestamp: 1_700_086_402,
      },
    ],
  );

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
  const savedReferences = storage.stored('media-references');
  assert.equal(savedReferences.length, 3);
  const encryptedReference = savedReferences[0].toString('utf8');
  assert.equal(encryptedReference.includes('/image'), false);
  assert.equal(encryptedReference.includes('/video'), false);
  assert.equal(encryptedReference.includes('/audio'), false);
});

test('stopping the bridge keeps the linked device for the next start', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const calls: string[] = [];

  Object.defineProperty(connection, 'socket', {
    value: { end: () => calls.push('end'), logout: async () => calls.push('logout') },
    writable: true,
  });

  await connection.close();

  assert.deepEqual(calls, ['end']);
});

test('lists the chats renamed since the last refresh, and asks for a full refresh after a start', async () => {
  const storage = new MemoryStorage();
  const connection = new WhatsAppConnection(storage, randomBytes(32));
  const rename = (name: string) => connection.recordHistory([], [], false, [{ id: CHAT_ID, name } as Chat]);

  const start = await connection.getNameChanges();
  assert.equal(start.full, true, 'changes made before this start were not tracked');
  connection.acknowledgeNameChanges(start.version);

  await rename('Alice');
  const first = await connection.getNameChanges();
  assert.deepEqual(first.names, [{ chatId: CHAT_ID, name: 'Alice' }]);
  assert.equal(first.full, false);

  await rename('Alice Martin');
  connection.acknowledgeNameChanges(first.version);
  assert.deepEqual(
    (await connection.getNameChanges()).names,
    [{ chatId: CHAT_ID, name: 'Alice Martin' }],
    'a change after the refresh read its list stays listed',
  );

  connection.acknowledgeNameChanges((await connection.getNameChanges()).version);
  assert.deepEqual(await connection.getNameChanges(), { version: 2, full: false, names: [] });
});

test('a sync batch waits for the API budget, and only one sync job waits at a time', async () => {
  const storage = new MemoryStorage();
  const budget = new ApiBudget(10);
  const connection = new WhatsAppConnection(storage, randomBytes(32), undefined, undefined, budget);
  const events = (connection as unknown as { events: { write: (key: string, value: MessageEvent) => Promise<void> } })
    .events;

  await events.write('a'.repeat(64), {
    eventId: 'a'.repeat(64),
    chatId: CHAT_ID,
    providerMessageId: 'message-a',
    direction: 'inbound',
    text: 'Hello',
    sentAt: new Date().toISOString(),
  });
  budget.adjust(20);

  const first = await connection.claimEvents();
  assert.equal(first.leaseId, undefined);
  assert.ok(first.waitMs && first.waitMs > 0, 'the job is told when to come back');
  const second = await connection.claimEvents();
  assert.equal(second.waitMs, undefined, 'a second job ends: the first one will come back');
  assert.equal(second.leaseId, undefined);
});
