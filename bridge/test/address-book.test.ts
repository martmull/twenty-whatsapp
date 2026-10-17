import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { encodeSyncdPatch, newLTHashState, proto, type SignalKeyStore, type WASocket } from '@whiskeysockets/baileys';

import { fetchAddressBook, splitContactName } from '../src/address-book.js';
import { WhatsAppConnection } from '../src/connection.js';

const keyId = Buffer.from('contacts-key').toString('base64');
const appStateKey = proto.Message.AppStateSyncKeyData.fromObject({ keyData: randomBytes(32), timestamp: 1 });
const keys = {
  get: async (_type: string, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, id === keyId ? appStateKey : undefined])),
  set: async () => undefined,
} as unknown as SignalKeyStore;

// Builds the server reply for the contacts collection the way WhatsApp sends saved contacts.
const contactsReply = async (contacts: { index: string[]; value: proto.ISyncActionValue }[]) => {
  let state = newLTHashState();
  const patches = [];
  for (const contact of contacts) {
    const encoded = await encodeSyncdPatch(
      {
        type: 'critical_unblock_low',
        index: contact.index,
        syncAction: contact.value,
        apiVersion: 2,
        operation: proto.SyncdMutation.SyncdOperation.SET,
      },
      keyId,
      state,
      async (id) => (id === keyId ? appStateKey : undefined),
    );
    state = encoded.state;
    patches.push({
      tag: 'patch',
      attrs: {},
      content: proto.SyncdPatch.encode({ ...encoded.patch, version: { version: state.version } }).finish(),
    });
  }

  return {
    tag: 'iq',
    attrs: {},
    content: [
      {
        tag: 'sync',
        attrs: {},
        content: [
          {
            tag: 'collection',
            attrs: { name: 'critical_unblock_low', version: '0' },
            content: [{ tag: 'patches', attrs: {}, content: patches }],
          },
        ],
      },
    ],
  };
};

test('saved contact names keep the first name chosen on the phone', () => {
  assert.deepEqual(splitContactName('Jean Pierre Martin', 'Jean Pierre'), {
    firstName: 'Jean Pierre',
    lastName: 'Martin',
  });
  assert.deepEqual(splitContactName('Martin Alex', 'Alex'), { firstName: 'Alex', lastName: 'Martin' });
  assert.deepEqual(splitContactName('Alex Martin'), { firstName: 'Alex', lastName: 'Martin' });
  assert.deepEqual(splitContactName('Mamie Jo', 'Mamie Jo'), { firstName: 'Mamie Jo', lastName: '' });
});

test('the address book is read with first and last names, including contacts saved by LID', async () => {
  const reply = await contactsReply([
    {
      index: ['contact', '33686388980@s.whatsapp.net'],
      value: { contactAction: { fullName: 'Camille Durand', firstName: 'Camille' } },
    },
    {
      index: ['contact', '123456789012345@lid'],
      value: {
        contactAction: { fullName: 'Léa Moreau', firstName: 'Léa', pnJid: '33637952219@s.whatsapp.net' },
      },
    },
    { index: ['contact', '33611111111@s.whatsapp.net'], value: { contactAction: { fullName: '+33611111111' } } },
  ]);
  const socket = { query: async () => reply } as unknown as WASocket;

  const { entries, report } = await fetchAddressBook(socket, keys);

  assert.equal(report.contacts, 2);
  assert.deepEqual(report.collections.critical_unblock_low, { records: 3, contactRecords: 3 });

  assert.deepEqual(
    entries.sort((left, right) => left.fullName.localeCompare(right.fullName)),
    [
      { ids: ['33686388980@s.whatsapp.net'], fullName: 'Camille Durand', firstName: 'Camille', lastName: 'Durand' },
      {
        ids: ['123456789012345@lid', '33637952219@s.whatsapp.net'],
        fullName: 'Léa Moreau',
        firstName: 'Léa',
        lastName: 'Moreau',
      },
    ],
  );
});

test('history review and import use the saved contact name over the WhatsApp profile name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-address-book-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const chatId = '33686388980@s.whatsapp.net';

  try {
    await connection.recordHistory(
      [],
      [
        {
          key: { remoteJid: chatId, id: 'saved-1', fromMe: false },
          pushName: 'cam ☀️',
          message: { conversation: 'Hello' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    );
    await connection.recordAddressBook([
      { ids: [chatId], fullName: 'Camille Durand', firstName: 'Camille', lastName: 'Durand' },
    ]);

    const [candidate] = (await connection.getHistoryCandidates(0, 0, 20)).items;
    assert.equal(candidate.name, 'Camille Durand');
    assert.equal(candidate.firstName, 'Camille');
    assert.equal(candidate.lastName, 'Durand');
    const history = await connection.getHistoryMessages(chatId, 0, 0, 25);
    assert.equal(history.firstName, 'Camille');
    assert.equal(history.lastName, 'Durand');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a contact saved by LID names the phone number once WhatsApp shares it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-address-book-lid-'));
  const connection = new WhatsAppConnection(directory, randomBytes(32));
  const lid = '123456789012345@lid';
  const chatId = '33637952219@s.whatsapp.net';

  try {
    await connection.recordAddressBook([{ ids: [lid], fullName: 'Léa Moreau', firstName: 'Léa', lastName: 'Moreau' }]);
    await connection.recordHistory(
      [{ id: lid, lid, jid: chatId }],
      [
        {
          key: { remoteJid: chatId, id: 'lid-1', fromMe: true },
          message: { conversation: 'Hello' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    );

    const [candidate] = (await connection.getHistoryCandidates(0, 0, 20)).items;
    assert.equal(candidate.name, 'Léa Moreau');
    assert.equal(candidate.firstName, 'Léa');
    assert.equal(candidate.lastName, 'Moreau');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
