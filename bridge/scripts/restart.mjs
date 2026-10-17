// Restarts the bridge listening on the configured port. A bridge run by a macOS launchd service is restarted
// through that service; otherwise its launch chain is stopped and `npm run dev` runs in this terminal.
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const bridgeDirectory = fileURLToPath(new URL('..', import.meta.url));
const env = await readFile(new URL('../.env', import.meta.url), 'utf8').catch(() => '');
const port = Number(env.match(/^WHATSAPP_BRIDGE_PORT=(\d+)$/m)?.[1] ?? 8765);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (condition, timeoutMs) => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    if (await condition()) return true;
  }
  return false;
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
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

// The process and its parents, closest first, up to (not including) launchd/init.
const processChain = async (processId) => {
  const chain = [];
  for (let id = processId; id > 1 && chain.length < 12;) {
    try {
      const { stdout } = await run('ps', ['-o', 'ppid=,command=', '-p', String(id)]);
      const [, parentId, command] = stdout.trim().match(/^(\d+)\s+(.*)$/s) ?? [];
      if (!parentId) break;
      chain.push({ id, parentId: Number(parentId), command });
      id = Number(parentId);
    } catch {
      break;
    }
  }
  return chain;
};

const isBridge = (command) => command.includes('src/server.ts');
// Processes that only exist to run the bridge: npm/sh wrappers, file watchers, and an earlier restart.
const isBridgeLauncher = (command) =>
  isBridge(command) || /\bnpm(?:-cli\.js)? run (?:dev|restart)\b|restart\.mjs|\btsx watch\b|nodemon/.test(command);

const launchdLabels = async () => {
  if (process.platform !== 'darwin') return new Map();
  const { stdout } = await run('launchctl', ['list']);
  return new Map(
    stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([processId, , label]) => /^\d+$/.test(processId) && label)
      .map(([processId, , label]) => [Number(processId), label]),
  );
};

const describe = (chain) => chain.map(({ id, command }) => `  ${id}  ${command}`).join('\n');

const runningIds = await listeningProcessIds();

for (const processId of runningIds) {
  const chain = await processChain(processId);
  if (!isBridge(chain[0]?.command ?? '')) {
    fail(`Port ${port} is used by another program:\n${describe(chain)}`);
  }

  const labels = await launchdLabels();
  const service = chain.map(({ id }) => labels.get(id)).find(Boolean);
  if (service) {
    console.log(`Restarting the WhatsApp bridge through its launchd service "${service}"…`);
    const domains = [`gui/${process.getuid()}`, `user/${process.getuid()}`];
    let kicked = false;
    for (const domain of domains) {
      kicked ||= await run('launchctl', ['kickstart', '-k', `${domain}/${service}`]).then(
        () => true,
        () => false,
      );
    }
    if (!kicked) fail(`launchctl could not restart "${service}"; restart it with launchctl kickstart -k.`);
    const restarted = await waitFor(async () => {
      const ids = await listeningProcessIds();
      return ids.length > 0 && ids.every((id) => !runningIds.includes(id));
    }, 60_000);
    if (!restarted) fail('The service did not bring the bridge back within 60 seconds; check its log.');
    console.log(`WhatsApp bridge restarted by launchd (pid ${(await listeningProcessIds()).join(', ')}).`);
    console.log(
      `Its output goes to the service log, not this terminal (see: launchctl print gui/${process.getuid()}/${service}).`,
    );
    process.exit(0);
  }

  const ownIds = (await processChain(process.pid)).map(({ id }) => id);
  const launchers = [];
  for (const entry of chain) {
    if (!isBridgeLauncher(entry.command) || ownIds.includes(entry.id)) break;
    launchers.push(entry);
  }

  console.log(`Stopping WhatsApp bridge (pid ${processId})…`);
  for (const { id } of launchers.reverse()) {
    try {
      process.kill(id, 'SIGTERM');
    } catch {
      // Already exited along with its parent.
    }
  }
  if (!(await waitFor(async () => (await listeningProcessIds()).length === 0, 15_000))) {
    console.log('The bridge did not stop in time; forcing it.');
    for (const { id } of launchers) {
      try {
        process.kill(id, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    await waitFor(async () => (await listeningProcessIds()).length === 0, 5_000);
  }
}

// Something outside this script may bring the bridge straight back; never start a second copy next to it.
await sleep(runningIds.length > 0 ? 2_000 : 0);
const [respawnedId] = await listeningProcessIds();
if (respawnedId) {
  const chain = await processChain(respawnedId);
  fail(
    `Something else restarted the bridge on port ${port}. Stop it there, or restart through it instead:\n${describe(chain)}\n` +
      `If the last line's parent is launchd, it is a background service: find it with launchctl list | grep ${chain.at(-1)?.id}`,
  );
}

console.log('Starting WhatsApp bridge…');
const bridge = spawn('npm', ['run', 'dev'], { cwd: bridgeDirectory, stdio: 'inherit' });
process.once('SIGTERM', () => bridge.kill('SIGTERM'));
// Ctrl+C reaches the bridge directly through the terminal; stay alive until it exits.
process.on('SIGINT', () => undefined);
bridge.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

const isOurs = async () => {
  for (const id of await listeningProcessIds()) {
    if ((await processChain(id)).some((entry) => entry.id === bridge.pid)) return true;
  }
  return false;
};

if (await waitFor(isOurs, 60_000)) {
  console.log(`WhatsApp bridge restarted on port ${port}.`);
} else {
  console.error('The bridge has not started listening after 60 seconds; check the log above.');
}
