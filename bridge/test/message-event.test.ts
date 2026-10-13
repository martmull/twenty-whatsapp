import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { WAMessage } from '@whiskeysockets/baileys';

import { EncryptedJsonStore } from '../src/encrypted-json-store.js';
import { toInboundMessageEvent } from '../src/message-event.js';

const message = (chatId: string, text: string, fromMe = false): WAMessage => ({
  key: { remoteJid: chatId, id: 'provider-1', fromMe },
  message: { conversation: text },
  messageTimestamp: 1_700_000_000,
});

test('only new direct incoming text can enter the queue', () => {
  const direct = toInboundMessageEvent(message('15551234567@s.whatsapp.net', 'Hello'));

  assert.equal(direct?.text, 'Hello');
  assert.equal(direct?.chatId, '15551234567@s.whatsapp.net');
  assert.equal(toInboundMessageEvent(message('15551234567@g.us', 'Group')), undefined);
  assert.equal(toInboundMessageEvent(message('15551234567@lid', 'LID')), undefined);
  assert.equal(toInboundMessageEvent(message('15551234567@s.whatsapp.net', 'Mine', true)), undefined);
});

test('queued message survives restart encrypted and can be acknowledged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-events-'));
  const key = randomBytes(32);
  const event = toInboundMessageEvent(message('15551234567@s.whatsapp.net', 'Private text'));
  assert.ok(event);

  try {
    const store = new EncryptedJsonStore<typeof event>(directory, key);
    await store.write(event.eventId, event);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.equal((await readFile(join(directory, files[0]))).includes(Buffer.from('Private text')), false);

    const restored = new EncryptedJsonStore<typeof event>(directory, key);
    assert.deepEqual(await restored.list(100), [event]);
    await restored.delete(event.eventId);
    assert.deepEqual(await restored.list(100), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
