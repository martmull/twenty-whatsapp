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
        : request.method === 'POST' && path === '/connect'
          ? await connection.connect()
          : request.method === 'POST' && path === '/disconnect'
            ? await connection.disconnect()
            : undefined;

    if (!result) {
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

server.listen(port, host, () => {
  process.stdout.write(`WhatsApp bridge listening on ${host}:${port}\n`);
});
