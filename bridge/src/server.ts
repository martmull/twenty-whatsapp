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
    const result =
      request.method === 'GET' && path === '/status'
        ? connection.getStatus()
        : request.method === 'GET' && path === '/events'
          ? await connection.getEvents()
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
