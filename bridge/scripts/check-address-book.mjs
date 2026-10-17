// Reads the phone's saved contacts through the running bridge and prints counts only, never names.
import { readFile } from 'node:fs/promises';

const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const token = env.match(/^WHATSAPP_BRIDGE_TOKEN=(.+)$/m)?.[1];
const port = Number(env.match(/^WHATSAPP_BRIDGE_PORT=(\d+)$/m)?.[1] ?? 8765);

if (!token) {
  throw new Error('Bridge token is missing');
}

const request = (path, method = 'GET') =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });

// Right after a restart the bridge is still reconnecting to WhatsApp.
for (let attempt = 0; ; attempt += 1) {
  const status = await request('/status')
    .then((statusResponse) => statusResponse.json())
    .catch(() => ({ state: 'unreachable' }));
  if (status.state === 'connected') break;
  if (status.qrDataUrl || attempt >= 60) {
    console.error(
      status.qrDataUrl
        ? 'WhatsApp logged this device out; link it again from the WhatsApp settings in Twenty.'
        : `WhatsApp is not connected after 60 seconds (state: ${status.state}).`,
    );
    process.exit(1);
  }
  if (attempt === 0) console.log('Waiting for WhatsApp to connect…');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const response = await request('/address-book/sync', 'POST');
const report = await response.json();

if (!response.ok) {
  console.error(`Bridge refused the request (${response.status}): ${report.error}`);
  process.exit(1);
}

console.log(`Saved contacts with a name: ${report.contacts}`);
console.log(`App-state key present: ${report.appStateKey ? 'yes' : 'no'}`);
for (const [name, collection] of Object.entries(report.collections)) {
  console.log(
    `  ${name}: ${collection.records} records, ${collection.contactRecords} contacts${collection.error ? ` (error: ${collection.error})` : ''}`,
  );
}
