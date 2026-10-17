import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';

import { WhatsAppConnection, type BridgeSignal } from './connection.js';
import { isGroupChatId, isSupportedChatId } from './message-event.js';

const token = process.env.WHATSAPP_BRIDGE_TOKEN;
const keyHex = process.env.WHATSAPP_SESSION_KEY;
const webhookUrl = process.env.TWENTY_WEBHOOK_URL;

if (!token || !keyHex || !/^[a-f\d]{64}$/i.test(keyHex)) {
  throw new Error('Set WHATSAPP_BRIDGE_TOKEN and a 32-byte hex WHATSAPP_SESSION_KEY');
}

const log = (message: string, data: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...data })}\n`);

// Sends signals to Twenty's webhook. Signals within one second are merged into one call; a failed
// call is retried with a growing delay, keeping any signals that arrive meanwhile.
const WEBHOOK_RETRY_MIN_MS = 30_000;
const WEBHOOK_RETRY_MAX_MS = 10 * 60_000;
let pendingSignal: BridgeSignal = {};
let webhookTimer: NodeJS.Timeout | undefined;
let webhookRetryDelayMs = WEBHOOK_RETRY_MIN_MS;

const mergeSignals = (older: BridgeSignal, newer: BridgeSignal): BridgeSignal => ({
  ...(older.events || newer.events ? { events: true } : {}),
  ...(older.names || newer.names ? { names: true } : {}),
  ...((newer.historyRunToken ?? older.historyRunToken)
    ? { historyRunToken: newer.historyRunToken ?? older.historyRunToken }
    : {}),
});

const deliverSignal = async () => {
  webhookTimer = undefined;
  const signal = pendingSignal;
  pendingSignal = {};
  const body = JSON.stringify({ sentAt: new Date().toISOString(), ...signal });
  const signature = createHmac('sha256', token).update(body).digest('hex');

  try {
    const response = await fetch(webhookUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-whatsapp-signature': signature },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    webhookRetryDelayMs = WEBHOOK_RETRY_MIN_MS;
  } catch (error) {
    log('Twenty webhook failed, will retry', { error: String(error), retryInMs: webhookRetryDelayMs });
    pendingSignal = mergeSignals(signal, pendingSignal);
    clearTimeout(webhookTimer);
    webhookTimer = setTimeout(deliverSignal, webhookRetryDelayMs);
    webhookRetryDelayMs = Math.min(webhookRetryDelayMs * 2, WEBHOOK_RETRY_MAX_MS);
  }
};

const notifyTwenty = (signal: BridgeSignal) => {
  if (!webhookUrl) return;
  pendingSignal = mergeSignals(pendingSignal, signal);
  if (!webhookTimer) webhookTimer = setTimeout(deliverSignal, 1_000);
};

const expectedToken = Buffer.from(token);
const connection = new WhatsAppConnection(
  resolve(process.env.WHATSAPP_DATA_DIR ?? './data/session'),
  Buffer.from(keyHex, 'hex'),
  notifyTwenty,
  log,
);

const isAuthorized = (header: string | undefined) => {
  const supplied = Buffer.from(header?.replace(/^Bearer /, '') ?? '');

  return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken);
};

const readBuffer = async (request: IncomingMessage, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, size);
};

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const raw = (await readBuffer(request, 16_384)).toString('utf8');
  const value: unknown = raw ? JSON.parse(raw) : {};

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid request body');
  }

  return value as Record<string, unknown>;
};

class BadRequest extends Error {}

const check = (condition: unknown, message = 'Invalid request'): void => {
  if (!condition) throw new BadRequest(message);
};

const isRange = (value: unknown): value is number => [7, 30, 90, 365].includes(value as number);
const isPage = (offset: unknown, limit: unknown, maxLimit: number) =>
  Number.isInteger(offset) &&
  (offset as number) >= 0 &&
  Number.isInteger(limit) &&
  (limit as number) >= 1 &&
  (limit as number) <= maxLimit;
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d-]{36}$/i.test(value);
const isEventId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000;
const isDelay = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 24 * 60 * 60_000;
const requireConnected = () => check(connection.getStatus().state === 'connected', 'WhatsApp is disconnected');

type Route = (body: Record<string, unknown>) => unknown;

const jsonRoutes: Record<string, Route> = {
  'GET /status': () => connection.getStatus(),
  'POST /connect': () => connection.connect(),
  'POST /disconnect': () => connection.disconnect(),
  'POST /events/claim': () => connection.claimEvents(),
  'POST /events/release': (body) => {
    check(typeof body.leaseId === 'string' && /^[a-f\d-]{36}$/i.test(body.leaseId));
    return connection.releaseEvents(body.leaseId as string);
  },
  'POST /events/ack': (body) => {
    check(Array.isArray(body.eventIds) && body.eventIds.every((id) => typeof id === 'string'));
    return connection.ackEvents(body.eventIds as string[]);
  },
  'POST /send': (body) => {
    check(
      typeof body.requestId === 'string' &&
        typeof body.chatId === 'string' &&
        typeof body.text === 'string' &&
        typeof body.accountPhoneNumber === 'string',
    );
    return connection.sendText(
      body.requestId as string,
      body.chatId as string,
      body.text as string,
      body.accountPhoneNumber as string,
    );
  },
  'POST /history/list': (body) => {
    requireConnected();
    check(
      isRange(body.rangeDays) &&
        isPage(body.offset, body.limit, 50) &&
        (body.kind === undefined || ['all', 'direct', 'group'].includes(body.kind as string)),
    );
    return connection.getHistoryCandidates(
      body.rangeDays as number,
      body.offset as number,
      body.limit as number,
      body.kind as 'all' | 'direct' | 'group' | undefined,
    );
  },
  'POST /history/messages': (body) => {
    requireConnected();
    check(typeof body.chatId === 'string' && isRange(body.rangeDays) && isPage(body.offset, body.limit, 100));
    return connection.getHistoryMessages(
      body.chatId as string,
      body.rangeDays as number,
      body.offset as number,
      body.limit as number,
    );
  },
  'POST /history/names': (body) => {
    requireConnected();
    check(
      Array.isArray(body.chatIds) && body.chatIds.length <= 100 && body.chatIds.every((id) => typeof id === 'string'),
    );
    return connection.getHistoryNames(body.chatIds as string[]);
  },
  'POST /history/imports/queue': (body) => {
    requireConnected();
    check(
      Array.isArray(body.tasks) &&
        body.tasks.length >= 1 &&
        body.tasks.length <= 50 &&
        body.tasks.every(
          (task: Record<string, unknown>) =>
            isSupportedChatId(task?.chatId as string) && isUuid(task.conversationId) && isRange(task.rangeDays),
        ),
    );
    return connection.historyImports.queue(
      body.tasks as { chatId: string; conversationId: string; rangeDays: number }[],
    );
  },
  'POST /history/imports/claim': (body) => {
    requireConnected();
    check(isUuid(body.runToken));
    return connection.historyImports.claim(body.runToken as string);
  },
  'POST /history/imports/complete': (body) => {
    check(
      isUuid(body.leaseId) &&
        (body.lastEventId === undefined || isEventId(body.lastEventId)) &&
        isCount(body.imported) &&
        isDelay(body.nextRunInMs),
    );
    return connection.historyImports.complete(
      body.leaseId as string,
      body.lastEventId as string | undefined,
      body.imported as number,
      body.nextRunInMs as number,
    );
  },
  'POST /history/imports/release': (body) => {
    check(isUuid(body.leaseId) && typeof body.failed === 'boolean' && isDelay(body.nextRunInMs));
    return connection.historyImports.release(
      body.leaseId as string,
      body.failed as boolean,
      body.nextRunInMs as number,
    );
  },
  'POST /history/imports/progress': () => connection.historyImports.progress(),
  'POST /address-book/sync': () => {
    requireConnected();
    return connection.syncAddressBook();
  },
  'POST /history/members': (body) => {
    check(isGroupChatId(body.chatId as string), 'Invalid group ID');
    return connection.getGroupMembers(body.chatId as string);
  },
};

// A 4,096-character caption can take 16 KB as UTF-8, about 22 KB once base64-encoded in the header.
const MAX_MEDIA_METADATA_LENGTH = 24_000;

const sendMedia = async (request: IncomingMessage) => {
  const encoded = request.headers['x-whatsapp-media'];
  check(typeof encoded === 'string' && encoded.length <= MAX_MEDIA_METADATA_LENGTH, 'Invalid media metadata');
  const media: Record<string, unknown> = JSON.parse(Buffer.from(encoded as string, 'base64').toString('utf8'));
  check(
    typeof media.requestId === 'string' &&
      typeof media.chatId === 'string' &&
      typeof media.accountPhoneNumber === 'string' &&
      ['image', 'video', 'document'].includes(media.kind as string) &&
      typeof media.mimeType === 'string' &&
      typeof media.fileName === 'string' &&
      typeof media.caption === 'string',
    'Invalid media metadata',
  );
  const bytes = await readBuffer(request, 64 * 1024 * 1024);
  check(bytes.length > 0, 'Empty attachment');

  return connection.sendMedia(
    media.requestId as string,
    media.chatId as string,
    media.accountPhoneNumber as string,
    media.kind as 'image' | 'video' | 'document',
    media.mimeType as string,
    media.fileName as string,
    media.caption as string,
    bytes,
  );
};

let resumed: Promise<unknown> = new Promise(() => undefined);

// Node's default 16 KB header limit would reject the metadata of a long caption.
const server = createServer({ maxHeaderSize: 32 * 1024 }, async (request, response) => {
  await resumed;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json');

  if (!isAuthorized(request.headers.authorization)) {
    response.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const routeKey = `${request.method} ${path}`;

  try {
    const mediaId = request.method === 'GET' ? /^\/media\/([a-f\d]{64})$/.exec(path)?.[1] : undefined;

    if (mediaId) {
      const media = await connection.getMedia(mediaId);
      response.setHeader('content-type', media.mimeType);
      response.setHeader('content-length', media.bytes.length);
      response.setHeader('x-content-type-options', 'nosniff');
      response.end(media.bytes);
      return;
    }

    if (routeKey === 'POST /send/media') {
      response.end(JSON.stringify(await sendMedia(request)));
      return;
    }

    const route = jsonRoutes[routeKey];

    if (!route) {
      response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const body = request.method === 'POST' ? await readJson(request) : {};
    response.end(JSON.stringify(await route(body)));
  } catch (error) {
    const isBadRequest = error instanceof BadRequest;
    log('Request failed', { route: routeKey, error: error instanceof Error ? error.message : String(error) });
    response
      .writeHead(isBadRequest ? 400 : 500)
      .end(JSON.stringify({ error: isBadRequest ? error.message : 'Bridge operation failed' }));
  }
});

const host = process.env.WHATSAPP_BRIDGE_HOST ?? '127.0.0.1';
const port = Number(process.env.WHATSAPP_BRIDGE_PORT ?? 8765);

// Take the port before linking to WhatsApp: a second bridge on the same account would replace the first session.
server.once('error', (error: NodeJS.ErrnoException) => {
  log(
    error.code === 'EADDRINUSE' ? 'Another bridge is already running; use npm run restart' : 'Bridge failed to start',
    {
      host,
      port,
      error: error.message,
    },
  );
  process.exit(1);
});
server.listen(port, host, () => {
  log('WhatsApp bridge listening', { host, port, webhook: Boolean(webhookUrl), pid: process.pid });
  resumed = connection
    .resume()
    .catch((error: unknown) => log('Could not resume WhatsApp session', { error: String(error) }));
});

const stop = async (signal: NodeJS.Signals) => {
  log('WhatsApp bridge stopping', { signal });
  server.close();
  await connection.close();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
