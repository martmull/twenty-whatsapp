// Stops the bridge listening on the configured port, if any, then runs `npm run dev` in this terminal.
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const bridgeDirectory = fileURLToPath(new URL('..', import.meta.url));
const env = await readFile(new URL('../.env', import.meta.url), 'utf8').catch(() => '');
const host = env.match(/^WHATSAPP_BRIDGE_HOST=(.+)$/m)?.[1]?.trim() || '127.0.0.1';
const port = Number(env.match(/^WHATSAPP_BRIDGE_PORT=(\d+)$/m)?.[1] ?? 8765);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isListening = () =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const waitFor = async (condition, timeoutMs) => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    if (await condition()) return true;
  }
  return false;
};

const listeningProcessIds = async () => {
  try {
    const { stdout } = await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return [...new Set(stdout.split('\n').filter(Boolean).map(Number))];
  } catch (error) {
    // lsof exits with 1 when nothing listens.
    if (error.code === 1) return [];
    throw new Error(`Could not inspect port ${port} (lsof is required): ${error.message}`, { cause: error });
  }
};

for (const processId of await listeningProcessIds()) {
  const { stdout: command } = await run('ps', ['-o', 'command=', '-p', String(processId)]);
  if (!command.includes('src/server.ts')) {
    throw new Error(`Port ${port} is used by another program (pid ${processId}): ${command.trim()}`);
  }

  console.log(`Stopping WhatsApp bridge (pid ${processId})…`);
  process.kill(processId, 'SIGTERM');
  if (!(await waitFor(async () => !(await isListening()), 15_000))) {
    console.log('The bridge did not stop in time; forcing it.');
    process.kill(processId, 'SIGKILL');
    await waitFor(async () => !(await isListening()), 5_000);
  }
}

if (await isListening()) {
  throw new Error(`Port ${port} is still in use; stop the process holding it and retry.`);
}

console.log('Starting WhatsApp bridge…');
const bridge = spawn('npm', ['run', 'dev'], { cwd: bridgeDirectory, stdio: 'inherit' });
process.once('SIGTERM', () => bridge.kill('SIGTERM'));
// Ctrl+C reaches the bridge directly through the terminal; stay alive until it exits.
process.on('SIGINT', () => undefined);
bridge.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

if (await waitFor(isListening, 60_000)) {
  console.log(`WhatsApp bridge restarted on ${host}:${port}.`);
} else {
  console.error('The bridge has not started listening after 60 seconds; check the log above.');
}
