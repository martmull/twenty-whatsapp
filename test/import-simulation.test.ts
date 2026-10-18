import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApiBudget } from '../bridge/src/api-budget';
import { HistoryImportQueue } from '../bridge/src/history-import-queue';
import { MediaQueue } from '../bridge/src/media-queue';
import { historyJobId, runHistoryImportStep } from '../src/logic-functions/history-import';
import { mediaJobId, queueMedia, runMediaImport } from '../src/logic-functions/media-import';
import { createFakeTwenty, mockBridge } from './fake-twenty';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const CHATS = 50;
const MESSAGES_PER_CHAT = 200;
const MEDIA_EVERY = 4;
// Twenty's limit on the jobs an app installation may queue per minute.
const ENQUEUE_LIMIT_PER_MINUTE = 500;

const chatId = (chat: number) => `1555${String(chat).padStart(7, '0')}@s.whatsapp.net`;
const conversationId = (chat: number) => `00000000-0000-4000-8000-${String(chat).padStart(12, '0')}`;
const message = (chat: number, index: number) => ({
  eventId: `${chat.toString(16).padStart(8, '0')}${index.toString(16).padStart(56, '0')}`,
  chatId: chatId(chat),
  providerMessageId: `message-${chat}-${index}`,
  direction: (index % 2 ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
  text: `Message ${index}`,
  sentAt: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
  ...(index % MEDIA_EVERY === 0
    ? { media: { kind: 'image' as const, mimeType: 'image/jpeg', fileName: 'a.jpg' } }
    : {}),
});

// Runs the queued jobs in time order, as Twenty's worker would, ignoring a job ID it has seen before.
const createJobRunner = (clock: { now: number }) => {
  const jobs: { at: number; kind: 'history' | 'media'; payload: Record<string, unknown> }[] = [];
  const seenJobIds = new Set<string>();
  const enqueuedPerMinute = new Map<number, number>();
  const add = (kind: 'history' | 'media', payload: Record<string, unknown>, delayMs: number, jobId?: string) => {
    if (jobId && seenJobIds.has(jobId)) return;
    if (jobId) seenJobIds.add(jobId);
    const minute = Math.floor(clock.now / 60_000);
    enqueuedPerMinute.set(minute, (enqueuedPerMinute.get(minute) ?? 0) + 1);
    jobs.push({ at: clock.now + delayMs, kind, payload });
  };
  const next = () => {
    jobs.sort((left, right) => left.at - right.at);
    const job = jobs.shift();
    if (job) clock.now = Math.max(clock.now, job.at);
    return job;
  };
  return { add, next, enqueuedPerMinute };
};

test('imports 10,000 messages and 2,500 files from 50 chats, within Twenty’s job and API limits', async () => {
  const history = Object.fromEntries(
    Array.from({ length: CHATS }, (_, chat) => [
      chatId(chat),
      Array.from({ length: MESSAGES_PER_CHAT }, (_, index) => message(chat, index)),
    ]),
  );
  const directory = await mkdtemp(join(tmpdir(), 'twenty-whatsapp-simulation-'));
  const clock = { now: Date.UTC(2026, 9, 18) };
  const budget = new ApiBudget(200, () => clock.now);
  const historyQueue = new HistoryImportQueue(join(directory, 'history'), randomBytes(32), async (id) => history[id], {
    now: () => clock.now,
    budget,
  });
  const mediaQueue = new MediaQueue(join(directory, 'media'), randomBytes(32), { now: () => clock.now, budget });
  const twenty = createFakeTwenty({
    whatsappConversations: Array.from({ length: CHATS }, (_, chat) => ({
      id: conversationId(chat),
      name: `Chat ${chat}`,
      chatId: chatId(chat),
      accountId: 'acc',
    })),
  });
  const bridge = mockBridge({
    '/history/imports/claim': (body) => historyQueue.claim(body.runToken as string, body.pageSeq as number),
    '/history/imports/complete': (body) =>
      historyQueue.complete(
        body.leaseId as string,
        body.imported as Record<string, number>,
        body.nextRunInMs as number,
        body.requests as number,
      ),
    '/history/imports/release': (body) =>
      historyQueue.release(body.leaseId as string, body.failed as boolean, body.nextRunInMs as number),
    '/media/queue': (body) =>
      mediaQueue.queue(
        (body.items as { messageId: string; eventId: string; fileName: string }[]).map((item) => ({
          ...item,
          source: 'history' as const,
        })),
      ),
    '/media/claim': (body) => mediaQueue.claim(body.runToken as string, body.seq as number),
    '/media/complete': (body) =>
      mediaQueue.complete(body.leaseId as string, body.processed as string[], body.requests as number),
    '/media/release': (body) =>
      mediaQueue.release(body.leaseId as string, body.failed as boolean, body.nextRunInMs as number),
  });
  const runner = createJobRunner(clock);
  const startMedia = async (runTokens: string[]) => {
    for (const runToken of runTokens) runner.add('media', { runToken, seq: 0 }, 0, mediaJobId(runToken, '0'));
  };
  let uploads = 0;

  try {
    const { runToken } = await historyQueue.queue(
      Array.from({ length: CHATS }, (_, chat) => ({
        chatId: chatId(chat),
        conversationId: conversationId(chat),
        rangeDays: 0,
      })),
    );
    runner.add('history', { runToken, pageSeq: 0 }, 0, historyJobId(runToken!, '0'));

    for (let job = runner.next(), runs = 0; job && runs < 1_000; job = runner.next(), runs += 1) {
      if (job.kind === 'history') {
        await runHistoryImportStep(job.payload, silentLogger, {
          client: twenty.client,
          isCancelled: async () => false,
          queueFiles: (items) => queueMedia(items, 'history', startMedia),
          enqueue: async (token, delayMs, position) =>
            runner.add(
              'history',
              { runToken: token, pageSeq: position?.pageSeq },
              delayMs,
              position && historyJobId(token, position.jobKey),
            ),
        });
      } else {
        await runMediaImport(job.payload as never, silentLogger, {
          client: twenty.client,
          enqueue: async (payload, delayMs, jobId) =>
            runner.add('media', payload as Record<string, unknown>, delayMs, jobId),
          upload: async (items) => {
            uploads += items.length;
            return {
              writes: items.map((item) => ({
                id: item.messageId,
                media: [{ fileId: '11111111-1111-4111-8111-111111111111', label: item.fileName }],
              })),
              processed: items.length,
            };
          },
        });
      }
    }
  } finally {
    bridge.restore();
    await rm(directory, { recursive: true, force: true });
  }

  const expectedFiles = CHATS * Math.ceil(MESSAGES_PER_CHAT / MEDIA_EVERY);
  assert.ok(
    (await historyQueue.progress()).every((task) => task.state === 'done'),
    'every chat is imported',
  );
  assert.equal(twenty.store.whatsappMessages.length, CHATS * MESSAGES_PER_CHAT);
  assert.equal(twenty.store.whatsappMessages.filter((row) => row.media).length, expectedFiles);
  assert.equal(uploads, expectedFiles, 'each file is uploaded once');
  assert.ok(
    Math.max(...runner.enqueuedPerMinute.values()) < ENQUEUE_LIMIT_PER_MINUTE / 2,
    `at most ${Math.max(...runner.enqueuedPerMinute.values())} jobs queued in a minute`,
  );
});
