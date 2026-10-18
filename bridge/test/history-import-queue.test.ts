import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ApiBudget } from '../src/api-budget.js';
import { HistoryImportQueue, MAX_PAGE_MESSAGES, type HistoryImportPage } from '../src/history-import-queue.js';
import type { MessageEvent } from '../src/message-event.js';

const CHAT_ID = '15551234567@s.whatsapp.net';
const OTHER_CHAT_ID = '15557654321@s.whatsapp.net';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

const message = (index: number, overrides: Partial<MessageEvent> = {}): MessageEvent => ({
  eventId: index.toString(16).padStart(64, '0'),
  chatId: CHAT_ID,
  providerMessageId: `message-${index}`,
  direction: index % 2 ? 'outbound' : 'inbound',
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  ...overrides,
});
const messages = (count: number, chatId = CHAT_ID, offset = 0) =>
  Array.from({ length: count }, (_, index) => message(offset + index, { chatId }));

const withQueue = async (
  messagesByChat: Record<string, MessageEvent[]>,
  run: (
    queue: HistoryImportQueue,
    clock: { now: number },
    world: { connected: boolean; restartedChains: string[]; budget: ApiBudget },
  ) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-imports-'));
  const clock = { now: Date.UTC(2026, 9, 16) };
  const world = {
    connected: true,
    restartedChains: [] as string[],
    budget: new ApiBudget(100, () => clock.now),
  };
  try {
    await run(
      new HistoryImportQueue(directory, randomBytes(32), async (chatId) => messagesByChat[chatId], {
        now: () => clock.now,
        onChainRestarted: (runToken) => world.restartedChains.push(runToken),
        canRun: () => world.connected,
        budget: world.budget,
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

const sortedProgress = async (queue: HistoryImportQueue) =>
  (await queue.progress()).sort((left, right) => left.chatId.localeCompare(right.chatId));

const queueBoth = (queue: HistoryImportQueue) =>
  queue.queue([
    { chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 },
    { chatId: OTHER_CHAT_ID, conversationId: OTHER_CONVERSATION_ID, rangeDays: 0 },
  ]);

test('packs several chats into 200-message pages, then writes their summaries together', async () => {
  const first = messages(150);
  const second = messages(100, OTHER_CHAT_ID, 500);

  await withQueue({ [CHAT_ID]: first, [OTHER_CHAT_ID]: second }, async (queue) => {
    const { runToken } = await queueBoth(queue);
    assert.ok(runToken);

    const page = asPage(await queue.claim(runToken, 0));
    assert.deepEqual(
      page.chats.map((chat) => [chat.chatId, chat.messages.length, chat.isLastPage]),
      [
        [CHAT_ID, 150, true],
        [OTHER_CHAT_ID, 50, false],
      ],
    );
    assert.equal(
      page.chats.reduce((sum, chat) => sum + chat.messages.length, 0),
      MAX_PAGE_MESSAGES,
    );
    assert.deepEqual(page.summaries, [], 'one finished chat is not worth a write yet');
    assert.deepEqual(await queue.complete(page.leaseId, { [CHAT_ID]: 150, [OTHER_CHAT_ID]: 50 }, 1_000), {
      remaining: 2,
      pageSeq: 1,
      nextJobKey: '1',
      nextRunInMs: 1_000,
    });

    const rest = asPage(await queue.claim(runToken, 1));
    assert.deepEqual(
      rest.chats.map((chat) => [chat.chatId, chat.messages[0].eventId, chat.isLastPage]),
      [[OTHER_CHAT_ID, second[50].eventId, true]],
    );
    await queue.complete(rest.leaseId, { [OTHER_CHAT_ID]: 50 }, 0);

    const summaries = asPage(await queue.claim(runToken, 2));
    assert.deepEqual(summaries.chats, []);
    assert.deepEqual(summaries.summaries, [
      {
        chatId: CHAT_ID,
        conversationId: CONVERSATION_ID,
        lastMessage: { sentAt: first[149].sentAt, text: first[149].text },
        lastInboundAt: first[148].sentAt,
      },
      {
        chatId: OTHER_CHAT_ID,
        conversationId: OTHER_CONVERSATION_ID,
        lastMessage: { sentAt: second[99].sentAt, text: second[99].text },
        lastInboundAt: second[98].sentAt,
      },
    ]);
    assert.equal((await queue.complete(summaries.leaseId, {}, 0)).remaining, 0);
    assert.deepEqual(await sortedProgress(queue), [
      { chatId: CHAT_ID, imported: 150, processed: 150, total: 150, state: 'done' },
      { chatId: OTHER_CHAT_ID, imported: 100, processed: 100, total: 100, state: 'done' },
    ]);
    assert.deepEqual(await queue.claim(runToken, 3), { stale: true });
  });
});

test('a retried job gets its page back, and a job for an earlier page stops', async () => {
  await withQueue({ [CHAT_ID]: messages(250) }, async (queue) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    const page = asPage(await queue.claim(runToken!, 0));

    assert.deepEqual(await queue.claim(runToken!, 0), page, 'the same page, for an idempotent retry');
    assert.deepEqual(await queue.claim(runToken!, 1), { stale: true }, 'a page is leased to one job at a time');

    await queue.complete(page.leaseId, { [CHAT_ID]: 200 }, 0);
    assert.deepEqual(await queue.complete(page.leaseId, { [CHAT_ID]: 200 }, 0), {
      remaining: 1,
      pageSeq: 1,
      nextJobKey: '1',
      nextRunInMs: 1_000,
    });
    assert.deepEqual(await queue.claim(runToken!, 0), { stale: true }, 'a retry of a finished page stops');
    assert.equal(asPage(await queue.claim(runToken!, 1)).chats[0].messages.length, 50);
  });
});

test('a retry of a released page gets its own job key', async () => {
  await withQueue({ [CHAT_ID]: messages(3) }, async (queue) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    const page = asPage(await queue.claim(runToken!, 0));

    assert.deepEqual(await queue.release(page.leaseId, false, 60_000), {
      remaining: 1,
      pageSeq: 0,
      nextJobKey: '0-1',
      nextRunInMs: 60_000,
      failures: 0,
    });
    assert.equal(asPage(await queue.claim(runToken!, 0)).chats[0].messages.length, 3);
  });
});

test('serves a failing chat alone, sets it aside after repeated failures, and replaces a lost chain', async () => {
  await withQueue(
    { [CHAT_ID]: messages(2), [OTHER_CHAT_ID]: messages(2, OTHER_CHAT_ID, 10) },
    async (queue, clock, world) => {
      const { runToken } = await queueBoth(queue);

      const shared = asPage(await queue.claim(runToken!, 0));
      assert.equal(shared.chats.length, 2);
      await queue.release(shared.leaseId, true, 0);

      const alone = asPage(await queue.claim(runToken!, 0));
      assert.deepEqual(
        alone.chats.map((chat) => chat.chatId),
        [CHAT_ID],
        'a chat that failed no longer shares its page',
      );
      for (let attempt = 2; attempt <= 4; attempt += 1) {
        const page = asPage(await queue.claim(runToken!, 0));
        assert.equal((await queue.release(page.leaseId, true, 60_000)).failures, attempt);
      }

      clock.now += 10 * 60_000;
      world.connected = false;
      assert.deepEqual(await queue.recoverStalled(), {}, 'no chain starts while WhatsApp is disconnected');
      world.connected = true;
      const { runToken: resumedToken } = await queue.recoverStalled();
      assert.ok(resumedToken);
      assert.deepEqual(world.restartedChains, [resumedToken], 'Twenty is asked to start the new chain');
      assert.deepEqual(await queue.claim(runToken!, 0), { stale: true }, 'the lost chain cannot come back');

      const last = asPage(await queue.claim(resumedToken, 0));
      await queue.release(last.leaseId, true, 0);
      assert.deepEqual(
        (await sortedProgress(queue)).map((task) => [task.chatId, task.state]),
        [
          [CHAT_ID, 'failed'],
          [OTHER_CHAT_ID, 'queued'],
        ],
      );
      assert.deepEqual(
        asPage(await queue.claim(resumedToken, 0)).chats.map((chat) => chat.chatId),
        [OTHER_CHAT_ID],
        'the other chat carries on',
      );
    },
  );
});

test('a second import joins the running chain, and the next run starts from an empty progress bar', async () => {
  await withQueue({ [CHAT_ID]: messages(4), [OTHER_CHAT_ID]: messages(1, OTHER_CHAT_ID, 9) }, async (queue) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    const joined = await queue.queue([{ chatId: OTHER_CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    assert.equal(joined.runToken, undefined);
    assert.deepEqual(await queue.recoverStalled(), {}, 'a live chain is not duplicated');

    for (let pageSeq = 0; ; pageSeq += 1) {
      const page = await queue.claim(runToken!, pageSeq);
      if (!('leaseId' in page)) break;
      await queue.complete(page.leaseId, {}, 0);
    }
    await queue.queue([{ chatId: OTHER_CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    assert.deepEqual(
      (await queue.progress()).map((task) => task.chatId),
      [OTHER_CHAT_ID],
      'the finished run is cleared',
    );
  });
});

test('counts only the messages inside the selected range', async () => {
  const old = message(1, { sentAt: '2026-01-01T00:00:00.000Z' });
  const recent = message(2, { sentAt: '2026-10-10T00:00:00.000Z' });

  await withQueue({ [CHAT_ID]: [old, recent] }, async (queue) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 30 }]);
    assert.deepEqual(await queue.progress(), [
      { chatId: CHAT_ID, imported: 0, processed: 0, total: 1, state: 'queued' },
    ]);
    assert.deepEqual(
      asPage(await queue.claim(runToken!, 0)).chats[0].messages.map((item) => item.eventId),
      [recent.eventId],
    );
  });
});

test('when the API budget is spent, tells the job to come back for the same page', async () => {
  await withQueue({ [CHAT_ID]: messages(3) }, async (queue, clock, world) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    world.budget.adjust(95);

    const wait = await queue.claim(runToken!, 0);
    assert.deepEqual(wait, { waitMs: 3_600, pageSeq: 0, nextJobKey: '0-1' });
    assert.deepEqual(await queue.recoverStalled(), {}, 'a waiting chain is alive');

    clock.now += 3_600;
    const page = asPage(await queue.claim(runToken!, 0));
    await queue.complete(page.leaseId, {}, 0, 3);
    assert.ok('waitMs' in (await queue.claim(runToken!, 1)), 'requests beyond the estimate are charged');
  });
});

test('cancelling drops the chats still queued and stops the chain', async () => {
  await withQueue({ [CHAT_ID]: messages(250), [OTHER_CHAT_ID]: messages(3, OTHER_CHAT_ID, 900) }, async (queue) => {
    const { runToken } = await queueBoth(queue);
    const page = asPage(await queue.claim(runToken!, 0));

    assert.deepEqual(await queue.cancel(), { cancelled: 2, runToken });
    assert.deepEqual(await queue.claim(runToken!, 0), { stale: true }, 'queued jobs of the chain stop');
    assert.equal((await queue.complete(page.leaseId, {}, 0)).remaining, 0, 'a page in flight changes nothing');
    assert.deepEqual(await queue.progress(), []);
    assert.deepEqual(await queue.recoverStalled(), {}, 'no chain is started again');
  });
});

test('spaces pages at least a second apart, counted from when the job started', async () => {
  await withQueue({ [CHAT_ID]: messages(450) }, async (queue) => {
    const { runToken } = await queue.queue([{ chatId: CHAT_ID, conversationId: CONVERSATION_ID, rangeDays: 0 }]);
    const first = asPage(await queue.claim(runToken!, 0));
    assert.equal((await queue.complete(first.leaseId, {}, 0, 1, 300)).nextRunInMs, 700);
    const second = asPage(await queue.claim(runToken!, 1));
    assert.equal((await queue.complete(second.leaseId, {}, 0, 1, 5_000)).nextRunInMs, 0);
  });
});
