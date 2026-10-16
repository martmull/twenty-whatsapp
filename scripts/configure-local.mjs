import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(appRoot, 'bridge', '.env');
const config = JSON.parse(
  await readFile(join(homedir(), '.twenty', 'config.json'), 'utf8'),
);
const remote = config.remotes?.local;

if (remote?.apiUrl !== 'http://localhost:2020' || !remote.apiKey) {
  throw new Error('The local Twenty remote must point to http://localhost:2020');
}

let env;

try {
  env = await readFile(envPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }

  env = [
    'WHATSAPP_BRIDGE_TOKEN=' + randomBytes(32).toString('hex'),
    'WHATSAPP_SESSION_KEY=' + randomBytes(32).toString('hex'),
    'WHATSAPP_BRIDGE_HOST=127.0.0.1',
  ].join('\n') + '\n';

  await writeFile(envPath, env, { mode: 0o600, flag: 'wx' });
}

const token = env.match(/^WHATSAPP_BRIDGE_TOKEN=(.+)$/m)?.[1];

if (!token) {
  throw new Error('The local bridge .env has no WHATSAPP_BRIDGE_TOKEN');
}

const graphql = async (query, variables) => {
  const response = await fetch(remote.apiUrl + '/metadata', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + remote.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();

  if (!response.ok || result.errors?.length) {
    throw new Error(result.errors?.[0]?.message ?? 'Twenty metadata request failed');
  }

  return result.data;
};

const app = await graphql(
  'query ($id: UUID!) { findOneApplication(universalIdentifier: $id) { id } }',
  { id: '7202b0dc-26c9-45cc-8b9a-97087693def1' },
);
const applicationId = app.findOneApplication?.id;

if (!applicationId) {
  throw new Error('WhatsApp app is not installed on the local Twenty instance');
}

const mutation = 'mutation ($applicationId: UUID!, $key: String!, $value: String!) { updateOneApplicationVariable(applicationId: $applicationId, key: $key, value: $value) }';

for (const [key, value] of [
  ['WHATSAPP_BRIDGE_URL', 'http://host.docker.internal:8765'],
  ['WHATSAPP_BRIDGE_TOKEN', token],
]) {
  const result = await graphql(mutation, { applicationId, key, value });

  if (result.updateOneApplicationVariable !== true) {
    throw new Error('Could not update ' + key);
  }
}

process.stdout.write('Local WhatsApp bridge variables configured in Twenty.\n');
