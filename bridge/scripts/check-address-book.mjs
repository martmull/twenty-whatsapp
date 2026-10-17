// Reads the phone's saved contacts through the running bridge and prints counts only, never names.
import { readFile } from 'node:fs/promises';

const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const token = env.match(/^WHATSAPP_BRIDGE_TOKEN=(.+)$/m)?.[1];
const port = Number(env.match(/^WHATSAPP_BRIDGE_PORT=(\d+)$/m)?.[1] ?? 8765);

if (!token) {
  throw new Error('Bridge token is missing');
}

const response = await fetch(`http://127.0.0.1:${port}/address-book/sync`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(120_000),
});
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
