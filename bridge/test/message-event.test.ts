import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import type { WAMessage } from '@whiskeysockets/baileys';

import { EncryptedJsonStore } from '../src/encrypted-json-store.js';
import { messageEventId, toMessageEvent } from '../src/message-event.js';

import { MemoryStorage } from './memory-storage.js';

const message = (chatId: string, text: string, fromMe = false): WAMessage => ({
  key: { remoteJid: chatId, id: 'provider-1', fromMe },
  message: { conversation: text },
  messageTimestamp: 1_700_000_000,
});

test('direct incoming and phone-sent text enter the queue with stable IDs', () => {
  const direct = toMessageEvent(message('15551234567@s.whatsapp.net', 'Hello'));
  const outgoing = toMessageEvent(message('15551234567@s.whatsapp.net', 'Mine', true));

  assert.equal(direct?.text, 'Hello');
  assert.equal(direct?.chatId, '15551234567@s.whatsapp.net');
  assert.equal(direct?.direction, 'inbound');
  assert.equal(outgoing?.direction, 'outbound');
  assert.equal(outgoing?.eventId, messageEventId('15551234567@s.whatsapp.net', 'provider-1'));
  assert.equal(toMessageEvent(message('15551234567@g.us', 'Group'))?.chatId, '15551234567@g.us');
  assert.equal(toMessageEvent(message('15551234567@lid', 'LID')), undefined);
});

test('a direct LID message with a shared phone number reaches the matching queue', () => {
  const incoming = message('123456789012345@lid', 'Qaa');
  incoming.key.senderPn = '15551234567@s.whatsapp.net';

  const event = toMessageEvent(incoming);

  assert.equal(event?.chatId, '15551234567@s.whatsapp.net');
  assert.equal(event?.text, 'Qaa');
});

test('a phone-sent LID message uses the contact mapping, never the sender phone', () => {
  const outgoing = message('123456789012345@lid', 'From my phone', true);
  outgoing.key.senderPn = '19999999999@s.whatsapp.net';

  assert.equal(toMessageEvent(outgoing), undefined);
  assert.equal(toMessageEvent(outgoing, '15551234567@s.whatsapp.net')?.chatId, '15551234567@s.whatsapp.net');
  assert.equal(toMessageEvent(outgoing, '15551234567@s.whatsapp.net')?.direction, 'outbound');
});

test('queued message survives restart encrypted and can be acknowledged', async () => {
  const storage = new MemoryStorage();
  const key = randomBytes(32);
  const event = toMessageEvent(message('15551234567@s.whatsapp.net', 'Private text'));
  assert.ok(event);

  const store = new EncryptedJsonStore<typeof event>(storage, 'events', key);
  await store.write(event.eventId, event);
  const stored = storage.stored('events');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].includes(Buffer.from('Private text')), false);

  const restored = new EncryptedJsonStore<typeof event>(storage, 'events', key);
  assert.deepEqual(await restored.list(100), [event]);
  await restored.delete(event.eventId);
  assert.deepEqual(await restored.list(100), []);
});
