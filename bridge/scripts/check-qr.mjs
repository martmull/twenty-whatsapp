import { readFile } from 'node:fs/promises';

const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const token = env.match(/^WHATSAPP_BRIDGE_TOKEN=(.+)$/m)?.[1];

if (!token) {
  throw new Error('Bridge token is missing');
}

const request = async (path, method = 'GET') => {
  const response = await fetch('http://127.0.0.1:8765' + path, {
    method,
    headers: { authorization: 'Bearer ' + token },
  });

  if (!response.ok) {
    throw new Error('Bridge request failed: ' + response.status);
  }

  return response.json();
};

const initialStatus = await request('/status');

if (initialStatus.state !== 'disconnected') {
  throw new Error('QR smoke check requires a disconnected bridge');
}

try {
  await request('/connect', 'POST');
  let hasQr = false;

  for (let attempt = 0; attempt < 15; attempt += 1) {
    const status = await request('/status');

    if (status.qrDataUrl?.startsWith('data:image/png;base64,')) {
      hasQr = true;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  process.stdout.write(hasQr ? 'QR generated successfully\n' : 'QR not generated within 15 seconds\n');

  if (!hasQr) {
    process.exitCode = 1;
  }
} finally {
  await request('/disconnect', 'POST');
}
