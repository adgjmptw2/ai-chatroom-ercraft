// Windows Task Scheduler owns this foreground process, not a Codex exec session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor, errorCode } from '../lib/service-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--configured-port')) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const port = config.port ?? 8321;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    process.stdout.write(String(port) + '\n');
    process.exit(0);
  } catch { process.stderr.write('CHATROOM_CONFIG_INVALID\n'); process.exit(1); }
}
const log = path.join(root, 'data', '.service-runtime', 'windows-host.jsonl');
function record(event, status = {}) {
  const row = { at: new Date().toISOString(), event, hostPid: process.pid,
    state: status.state, childPid: status.childPid, generation: status.generation,
    restarts: status.restarts, lastExit: status.lastExit, lastError: status.lastError,
    health: status.health };
  try {
    if (fs.existsSync(log) && fs.statSync(log).size > 1048576) fs.renameSync(log, log + '.previous');
    fs.appendFileSync(log, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch { process.stderr.write('CHATROOM_LIFECYCLE_LOG_FAILED\n'); }
}
let heartbeat;
try {
  const supervisor = await startSupervisor({ root, home: root });
  record('host-start', supervisor.status());
  let lastKey;
  let recovering = false;
  supervisor.on('status', status => {
    const key = JSON.stringify([status.state, status.childPid, status.restarts, status.lastError, status.lastExit]);
    if (key !== lastKey) { lastKey = key; record('state-change', status); }
    // The inner supervisor exhausted its bounded crash budget. Release cleanly
    // before letting Task Scheduler perform its own bounded host retry.
    if (status.state === 'exhausted' && !recovering) {
      recovering = true;
      process.exitCode = 1;
      void supervisor.stop('windows-recovery-budget').catch(() => { process.exitCode = 1; });
    }
  });
  heartbeat = setInterval(() => record('heartbeat', supervisor.status()), 60000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    record('host-signal-' + signal, supervisor.status());
    void supervisor.stop(signal);
  });
  await supervisor.done;
  record('host-exit', supervisor.status());
} catch (error) {
  record('host-error', { lastError: errorCode(error) });
  process.exitCode = 1;
} finally { clearInterval(heartbeat); }
