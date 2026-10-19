import assert from 'node:assert/strict';
import { test } from 'node:test';

import { messageRecord, summarizeEvents, summaryPatch } from '../src/logic-functions/message-data';
import {
  chunkRecords,
  deterministicId,
  rateLimitRetryAfterMs,
  upsertMessages,
} from '../src/logic-functions/record-writes';

const CHAT_ID = '15551234567@s.whatsapp.net';
const event = (index: number, overrides: Record<string, unknown> = {}) => ({
  eventId: index.toString(16).padStart(64, '0'),
  chatId: CHAT_ID,
  providerMessageId: `provider-${index}`,
  direction: 'inbound' as const,
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  ...overrides,
});

test('derives stable UUID v5 ids that Twenty accepts and that differ by kind and key', () => {
  const id = deterministicId('person', '+15551234567');

  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(deterministicId('person', '+15551234567'), id);
  assert.notEqual(deterministicId('person', '+15551234568'), id);
  assert.notEqual(deterministicId('conversation', '+15551234567'), id);
});

test('reads the retry delay Twenty sends with a rate limit, and assumes a full window otherwise', () => {
  assert.equal(
    rateLimitRetryAfterMs({ errors: [{ extensions: { code: 'RATE_LIMITED', retryAfterMs: 1234.2 } }] }),
    1235,
  );
  assert.equal(rateLimitRetryAfterMs(new Error('Limit reached (100 tokens per 60000 ms)')), 60_000);
  assert.equal(rateLimitRetryAfterMs(new Error('Could not create WhatsApp messages')), undefined);
});

test('splits writes at 200 records and at the byte cap', () => {
  assert.deepEqual(
    chunkRecords(Array.from({ length: 450 }, (_, index) => ({ index }))).map((chunk) => chunk.length),
    [200, 200, 50],
  );
  const long = { text: 'x'.repeat(4_000) };
  assert.deepEqual(
    chunkRecords(
      Array.from({ length: 10 }, () => long),
      200,
      10_000,
    ).map((chunk) => chunk.length),
    [2, 2, 2, 2, 2],
  );
});

test('upserts messages in one request per 200 and tells created rows from updated ones', async () => {
  const calls: { args: { data: unknown[]; upsert: boolean } }[] = [];
  const client = {
    mutation: async (selection: Record<string, { __args: { data: { externalId: string }[]; upsert: boolean } }>) => {
      const { __args } = selection.createWhatsappMessages;
      calls.push({ args: __args });
      return {
        createWhatsappMessages: __args.data.map((record, index) => ({
          id: `id-${record.externalId}`,
          externalId: record.externalId,
          conversationId: 'conversation',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: index % 2 ? '2026-10-02T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
        })),
      };
    },
  };

  const records = Array.from({ length: 250 }, (_, index) => messageRecord(event(index), 'conversation'));
  const written = await upsertMessages(client as never, records);

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.args.upsert === true));
  assert.equal(written.length, 250);
  assert.equal(written.filter((message) => message.created).length, 125);
});

test('a message record carries only the fields an import owns', () => {
  const record = messageRecord(
    event(1, {
      direction: 'outbound',
      media: { kind: 'image', mimeType: 'image/jpeg', fileName: 'a.jpg' },
      senderId: '15550000000@s.whatsapp.net',
    }),
    'conversation',
  );

  assert.equal(record.direction, 'OUTBOUND');
  assert.equal(record.deliveryState, 'SENT');
  assert.equal(record.mediaKind, 'IMAGE');
  assert.equal('media' in record, false, 'the media import owns the file');
  assert.equal('requestId' in record, false, 'the send route owns the request ID');
});

test('the summary patch moves forward only', () => {
  const summary = summarizeEvents([event(1), event(3, { direction: 'outbound' }), event(2)]);

  assert.equal(summary.latest?.text, 'Message 3');
  assert.equal(summary.latestInboundAt, event(2).sentAt);
  assert.deepEqual(summaryPatch(undefined, summary), {
    lastMessageAt: event(3).sentAt,
    lastPreview: 'Message 3',
    lastInboundAt: event(2).sentAt,
  });
  assert.equal(summaryPatch({ lastMessageAt: event(9).sentAt, lastInboundAt: event(9).sentAt }, summary), undefined);
  assert.deepEqual(summaryPatch({ lastMessageAt: event(9).sentAt, lastInboundAt: null }, summary), {
    lastInboundAt: event(2).sentAt,
  });
});
