import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  HISTORY_IMPORT_REQUESTS_PER_MINUTE,
  isRateLimitError,
  paceDelay,
  runHistoryImportStep,
} from '../src/logic-functions/history-import';

const RUN_TOKEN = '22222222-2222-4222-8222-222222222222';
const LEASE_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const CHAT_ID = '15551234567@s.whatsapp.net';
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const events = Array.from({ length: 100 }, (_, index) => ({
  eventId: index.toString(16).padStart(64, '0'),
  chatId: CHAT_ID,
  providerMessageId: `provider-${index}`,
  direction: index % 2 ? ('outbound' as const) : ('inbound' as const),
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
}));

let bridgeCalls: { path: string; body: Record<string, unknown> }[] = [];
let bridgeResponses: Record<string, unknown> = {};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.test';
  process.env.WHATSAPP_BRIDGE_TOKEN = 'token';
  bridgeCalls = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    bridgeCalls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(bridgeResponses[path] ?? {}));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const fakeClient = (onQuery?: () => void) => {
  const requests: string[] = [];
  const created: Record<string, unknown>[] = [];
  const client = {
    query: async (selection: Record<string, unknown>) => {
      requests.push('query');
      onQuery?.();
      if (selection.whatsappConversations) {
        return { whatsappConversations: { edges: [{ node: { id: CONVERSATION_ID, lastMessageAt: null } }] } };
      }
      return { whatsappMessages: { edges: [] } };
    },
    mutation: async (selection: Record<string, { __args: { data: Record<string, unknown>[] } }>) => {
      requests.push('mutation');
      if (selection.createWhatsappMessages) {
        created.push(...selection.createWhatsappMessages.__args.data);
        return { createWhatsappMessages: selection.createWhatsappMessages.__args.data.map((_, id) => ({ id })) };
      }
      return { updateWhatsappConversation: { id: CONVERSATION_ID } };
    },
  };
  return { client, requests, created };
};

test('imports a 100-message page in two requests, then schedules the next page at a paced delay', async () => {
  bridgeResponses = {
    '/history/imports/claim': {
      leaseId: LEASE_ID,
      chatId: CHAT_ID,
      conversationId: CONVERSATION_ID,
      messages: events,
      isLastPage: false,
    },
    '/history/imports/complete': { remaining: 1 },
  };
  const { client, requests, created } = fakeClient();
  const scheduled: { runToken: string; delayMs: number }[] = [];

  const result = await runHistoryImportStep(RUN_TOKEN, silentLogger, {
    client: client as never,
    enqueue: async (runToken, delayMs) => {
      scheduled.push({ runToken, delayMs });
    },
  });

  assert.equal(result.status, 'imported');
  assert.deepEqual(requests, ['query', 'mutation']);
  assert.equal(created.length, 100);
  const complete = bridgeCalls.find((call) => call.path === '/history/imports/complete');
  assert.equal(complete?.body.lastEventId, events.at(-1)!.eventId);
  assert.equal(complete?.body.imported, 100);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].runToken, RUN_TOKEN);
  // Two record requests plus the enqueue, spread over the per-minute budget.
  assert.ok(scheduled[0].delayMs <= (3 * 60_000) / HISTORY_IMPORT_REQUESTS_PER_MINUTE);
  assert.ok(scheduled[0].delayMs > 0);
});

test('writes the conversation summary once, on the last page, and stops the chain', async () => {
  bridgeResponses = {
    '/history/imports/claim': {
      leaseId: LEASE_ID,
      chatId: CHAT_ID,
      conversationId: CONVERSATION_ID,
      messages: events.slice(0, 3),
      isLastPage: true,
      summary: { lastMessage: events[2], lastInboundAt: events[2].sentAt },
    },
    '/history/imports/complete': { remaining: 0 },
  };
  const { client, requests } = fakeClient();
  let scheduled = 0;

  await runHistoryImportStep(RUN_TOKEN, silentLogger, {
    client: client as never,
    enqueue: async () => {
      scheduled += 1;
    },
  });

  assert.deepEqual(requests, ['query', 'mutation', 'query', 'mutation']);
  assert.equal(scheduled, 0);
});

test('gives the page back without blaming the chat when Twenty rate limits, and retries a minute later', async () => {
  bridgeResponses = {
    '/history/imports/claim': {
      leaseId: LEASE_ID,
      chatId: CHAT_ID,
      conversationId: CONVERSATION_ID,
      messages: events.slice(0, 3),
      isLastPage: false,
    },
    '/history/imports/release': { remaining: 1, failures: 0 },
  };
  const { client } = fakeClient(() => {
    throw new Error('Too Many Requests: Limit reached (100 tokens per 60000 ms)');
  });
  const delays: number[] = [];

  const result = await runHistoryImportStep(RUN_TOKEN, silentLogger, {
    client: client as never,
    enqueue: async (_runToken, delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(bridgeCalls.find((call) => call.path === '/history/imports/release')?.body.failed, false);
  assert.deepEqual(delays, [60_000]);
});

test('a superseded chain stops without touching Twenty', async () => {
  bridgeResponses = { '/history/imports/claim': { stale: true } };
  const { client, requests } = fakeClient();
  let scheduled = 0;

  assert.deepEqual(
    await runHistoryImportStep(RUN_TOKEN, silentLogger, {
      client: client as never,
      enqueue: async () => {
        scheduled += 1;
      },
    }),
    { status: 'idle' },
  );
  assert.equal(requests.length, 0);
  assert.equal(scheduled, 0);
});

test('recognizes rate limit errors and paces requests over the per-minute budget', () => {
  assert.equal(isRateLimitError({ errors: [{ message: 'x', extensions: { code: 'RATE_LIMITED' } }] }), true);
  assert.equal(isRateLimitError(new Error('Limit reached (100 tokens per 60000 ms)')), true);
  assert.equal(isRateLimitError(new Error('Could not create WhatsApp messages')), false);
  assert.equal(paceDelay(HISTORY_IMPORT_REQUESTS_PER_MINUTE, 0), 60_000);
  assert.equal(paceDelay(1, 60_000), 0);
});
