import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HistoryImportQueue, MAX_PAGE_MEDIA, type HistoryImportPage } from '../src/history-import-queue.js';
import type { MessageEvent } from '../src/message-event.js';

const CHAT_ID = '15551234567@s.whatsapp.net';
const OTHER_CHAT_ID = '15557654321@s.whatsapp.net';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

const message = (index: number, overrides: Partial<MessageEvent> = {}): MessageEvent => ({
  eventId: index.toString(16).padStart(64, '0'),
  chatId: CHAT_ID,
  providerMessageId: `message-${index}`,
  direction: index % 2 ? 'outbound' : 'inbound',
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  ...overrides,
});

const withQueue = async (
  messagesByChat: Record<string, MessageEvent[]>,
  run: (
    queue: HistoryImportQueue,
    clock: { now: number },
    world: { connected: boolean; restartedChains: string[] },
  ) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-imports-'));
  const clock = { now: Date.UTC(2026, 9, 16) };
  const world = { connected: true, restartedChains: [] as string[] };
  try {
    await run(
      new HistoryImportQueue(directory, randomBytes(32), async (chatId) => messagesByChat[chatId], {
        now: () => clock.now,
        onChainRestarted: (runToken) => world.restartedChains.push(runToken),
        canRun: () => world.connected,
      }),
      clock,
      world,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const asPage = (result: unknown): HistoryImportPage => {
  assert.ok(result && typeof result === 'object' && 'leaseId' in result, 'expected a page');
  return result as HistoryImportPage;
};

test('imports a chat page by page, cutting pages after a few media messages', async () => {
  const messages = Array.from({ length: 30 }, (_, index) =>
    message(
      index,
      index < MAX_PAGE_MEDIA + 2 ? { media: { kind: 'image', mimeType: 'image/jpeg', fileName: 'a.jpg' } } : {},
    ),
  );

  await withQueue({ [CHAT_ID]: messages }, async (queue) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    assert.ok(runToken);

    const first = asPage(await queue.claim(runToken));
    assert.equal(first.messages.length, MAX_PAGE_MEDIA);
    assert.equal(first.isLastPage, false);
    assert.equal(first.summary, undefined);
    assert.deepEqual(await queue.complete(first.leaseId, first.messages.at(-1)!.eventId, 5, 1_000), { remaining: 1 });
    assert.deepEqual(await queue.progress(), [{ chatId: CHAT_ID, imported: 5, total: 30, state: 'queued' }]);

    const second = asPage(await queue.claim(runToken));
    assert.equal(second.messages[0].eventId, messages[MAX_PAGE_MEDIA].eventId);
    assert.equal(second.isLastPage, true);
    assert.equal(second.summary?.lastMessage?.eventId, messages.at(-1)!.eventId);
    assert.equal(second.summary?.lastInboundAt, messages[28].sentAt);
    assert.deepEqual(await queue.complete(second.leaseId, second.messages.at(-1)!.eventId, 25, 1_000), {
      remaining: 0,
    });
    assert.deepEqual(await queue.progress(), []);
    assert.deepEqual(await queue.claim(runToken), { stale: true });
  });
});

test('resumes after a job stopped early instead of skipping the rest of the page', async () => {
  const messages = Array.from({ length: 10 }, (_, index) => message(index));

  await withQueue({ [CHAT_ID]: messages }, async (queue) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    const first = asPage(await queue.claim(runToken!));
    await queue.complete(first.leaseId, messages[3].eventId, 4, 0);

    const second = asPage(await queue.claim(runToken!));
    assert.deepEqual(
      second.messages.map((item) => item.eventId),
      messages.slice(4).map((item) => item.eventId),
    );
  });
});

test('keeps a single job chain: a second import joins the running chain', async () => {
  await withQueue(
    { [CHAT_ID]: [message(1)], [OTHER_CHAT_ID]: [message(2, { chatId: OTHER_CHAT_ID })] },
    async (queue) => {
      const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
      const joined = await queue.queue([{ chatId: OTHER_CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
      assert.equal(joined.runToken, undefined);

      const page = asPage(await queue.claim(runToken!));
      assert.equal(page.chatId, CHAT_ID);
      assert.deepEqual(await queue.claim(runToken!), { stale: true }, 'a page is leased to one job at a time');
      assert.deepEqual(await queue.complete(page.leaseId, page.messages[0].eventId, 1, 0), { remaining: 1 });
      assert.equal(asPage(await queue.claim(runToken!)).chatId, OTHER_CHAT_ID);
      assert.deepEqual(await queue.recoverStalled(), {}, 'a live chain is not duplicated');
    },
  );
});

test('sets a chat aside after repeated failures and replaces a lost chain once connected', async () => {
  await withQueue({ [CHAT_ID]: [message(1)] }, async (queue, clock, world) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const page = asPage(await queue.claim(runToken!));
      assert.deepEqual(await queue.release(page.leaseId, true, 60_000), { remaining: 1, failures: attempt });
    }

    clock.now += 10 * 60_000;
    world.connected = false;
    assert.deepEqual(await queue.recoverStalled(), {}, 'no chain starts while WhatsApp is disconnected');
    world.connected = true;
    const { runToken: resumedToken } = await queue.recoverStalled();
    assert.ok(resumedToken);
    assert.deepEqual(world.restartedChains, [resumedToken], 'Twenty is asked to start the new chain');
    assert.deepEqual(await queue.claim(runToken!), { stale: true }, 'the lost chain cannot come back');

    const page = asPage(await queue.claim(resumedToken));
    assert.deepEqual(await queue.release(page.leaseId, true, 0), { remaining: 0, failures: 5 });
    assert.deepEqual(await queue.progress(), [{ chatId: CHAT_ID, imported: 0, total: 1, state: 'failed' }]);
  });
});

test('counts only the messages inside the selected range', async () => {
  const old = message(1, { sentAt: '2026-01-01T00:00:00.000Z' });
  const recent = message(2, { sentAt: '2026-10-10T00:00:00.000Z' });

  await withQueue({ [CHAT_ID]: [old, recent] }, async (queue) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 30 }]);
    assert.deepEqual(await queue.progress(), [{ chatId: CHAT_ID, imported: 0, total: 1, state: 'queued' }]);
    assert.deepEqual(
      asPage(await queue.claim(runToken!)).messages.map((item) => item.eventId),
      [recent.eventId],
    );
  });
});
