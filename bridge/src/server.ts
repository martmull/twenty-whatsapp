import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { WhatsAppConnection } from './connection.js';

const token = process.env.WHATSAPP_BRIDGE_TOKEN;
const keyHex = process.env.WHATSAPP_SESSION_KEY;

if (!token || !keyHex || !/^[a-f\d]{64}$/i.test(keyHex)) {
  throw new Error('Set WHATSAPP_BRIDGE_TOKEN and a 32-byte hex WHATSAPP_SESSION_KEY');
}

const expectedToken = Buffer.from(token);
const connection = new WhatsAppConnection(
  resolve(process.env.WHATSAPP_DATA_DIR ?? './data/session'),
  Buffer.from(keyHex, 'hex'),
);

const isAuthorized = (header: string | undefined) => {
  const supplied = Buffer.from(header?.replace(/^Bearer /, '') ?? '');

  return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken);
};

const readBody = async (request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > 16_384) {
      throw new Error('Request body too large');
    }

    chunks.push(buffer);
  }

  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid request body');
  }

  return value as Record<string, unknown>;
};

const server = createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json');

  if (!isAuthorized(request.headers.authorization)) {
    response.writeHead(401);
    response.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const mediaId = request.method === 'GET' ? /^\/media\/([a-f\d]{64})$/.exec(path)?.[1] : undefined;
    if (mediaId) {
      const media = await connection.getMedia(mediaId);
      response.setHeader('content-type', media.mimeType);
      response.setHeader('content-length', media.bytes.length);
      response.setHeader('x-content-type-options', 'nosniff');
      response.end(media.bytes);
      return;
    }

    const result =
      request.method === 'GET' && path === '/status'
        ? connection.getStatus()
        : request.method === 'GET' && path === '/events'
          ? await connection.getEvents()
          : request.method === 'POST' && path === '/events/claim'
            ? await connection.claimEvents()
          : request.method === 'POST' && path === '/events/release'
            ? await (async () => {
              const body = await readBody(request);
              if (typeof body.leaseId !== 'string' || !/^[a-f\d-]{36}$/i.test(body.leaseId) || typeof body.completed !== 'boolean') {
                throw new Error('Invalid sync lease');
              }
              return connection.releaseEvents(body.leaseId, body.completed);
            })()
          : request.method === 'POST' && path === '/events/wait'
            ? await (async () => {
              const body = await readBody(request);
              if (typeof body.cursor !== 'string' || (body.cursor !== '' && !/^[a-f\d-]{36}$/i.test(body.cursor))) {
                throw new Error('Invalid cursor');
              }
              return connection.waitForChange(body.cursor);
            })()
          : request.method === 'POST' && path === '/events/notify'
            ? (connection.notifyChange(), { notified: true })
          : request.method === 'POST' && path === '/events/ack'
            ? await (async () => {
              const body = await readBody(request);
              if (!Array.isArray(body.eventIds) || !body.eventIds.every((id) => typeof id === 'string')) {
                throw new Error('Invalid event IDs');
              }
              return connection.ackEvents(body.eventIds);
            })()
            : request.method === 'POST' && path === '/send'
              ? await (async () => {
                const body = await readBody(request);
                if (typeof body.requestId !== 'string' || typeof body.chatId !== 'string' || typeof body.text !== 'string' || typeof body.accountPhoneNumber !== 'string') {
                  throw new Error('Invalid send request');
                }
                return connection.sendText(body.requestId, body.chatId, body.text, body.accountPhoneNumber);
              })()
        : request.method === 'POST' && path === '/connect'
          ? await connection.connect()
          : request.method === 'POST' && path === '/disconnect'
            ? await connection.disconnect()
            : request.method === 'POST' && path === '/history/list'
              ? await (async () => {
                const body = await readBody(request);
                if (connection.getStatus().state !== 'connected' || (body.rangeDays !== 0 && body.rangeDays !== 30 && body.rangeDays !== 90) || (body.kind !== undefined && body.kind !== 'all' && body.kind !== 'direct' && body.kind !== 'group') || !Number.isInteger(body.offset) || !Number.isInteger(body.limit) || (body.offset as number) < 0 || (body.limit as number) < 1 || (body.limit as number) > 50) {
                  throw new Error('Invalid history list request');
                }
                return connection.getHistoryCandidates(body.rangeDays, body.offset as number, body.limit as number, body.kind as 'all' | 'direct' | 'group' | undefined);
              })()
              : request.method === 'POST' && path === '/history/messages'
                ? await (async () => {
                  const body = await readBody(request);
                  if (connection.getStatus().state !== 'connected' || typeof body.chatId !== 'string' || (body.rangeDays !== 0 && body.rangeDays !== 30 && body.rangeDays !== 90) || !Number.isInteger(body.offset) || !Number.isInteger(body.limit) || (body.offset as number) < 0 || (body.limit as number) < 1 || (body.limit as number) > 100) {
                    throw new Error('Invalid history messages request');
                  }
                  return connection.getHistoryMessages(body.chatId, body.rangeDays, body.offset as number, body.limit as number);
                })()
                : request.method === 'POST' && path === '/history/members'
                  ? await (async () => {
                    const body = await readBody(request);
                    if (typeof body.chatId !== 'string' || !/^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(body.chatId)) {
                      throw new Error('Invalid group ID');
                    }
                    return connection.getGroupMembers(body.chatId);
                  })()
            : undefined;

    if (result === undefined) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    response.end(JSON.stringify(result));
  } catch {
    response.writeHead(500);
    response.end(JSON.stringify({ error: 'Bridge operation failed' }));
  }
});

const host = process.env.WHATSAPP_BRIDGE_HOST ?? '127.0.0.1';
const port = Number(process.env.WHATSAPP_BRIDGE_PORT ?? 8765);

await connection.resume();

server.listen(port, host, () => {
  process.stdout.write(`WhatsApp bridge listening on ${host}:${port}\n`);
});
