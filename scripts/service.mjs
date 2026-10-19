#!/usr/bin/env node
// Foreground entrypoint: retain this Node process in the owning exec/session.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor, controlService, backupSnapshot, verifySnapshot, restoreSnapshot, errorCode } from '../lib/service-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), action = args.shift() || 'status';
const options = { root, home: process.env.CHATROOM_HOME || root, configFile: process.env.CHATROOM_CONFIG };
const names = { '--home': 'home', '--config': 'configFile', '--backup-dir': 'backupDir', '--snapshot': 'snapshotPath', '--destination': 'destination' };
let invalid = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--offline') options.childStopped = true;
  else if (names[args[i]] && args[i + 1] && !args[i + 1].startsWith('--')) options[names[args[i]]] = path.resolve(args[++i]);
  else invalid = true;
}
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');

try {
  if (invalid) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' });
  if (action === 'run') {
    const supervisor = await startSupervisor(options);
    const status = () => supervisor.status();
    output({ ok: true, status: status() });
    supervisor.on('status', (value) => {
      // Safe lifecycle metadata only. Never print lock tokens, file hashes, config, or child logs.
      output({ event: 'service:status', status: value });
      if (process.connected) process.send({ type: 'service:status', status: value }, () => {});
    });
    const stop = () => { void supervisor.stop('owner-request'); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('disconnect', () => { void supervisor.stop('owner-disconnect'); });
    process.on('message', (message) => {
      if (message?.type === 'shutdown' || message?.type === 'service:stop') stop();
      else if (message?.type === 'service:status' && process.connected) {
        process.send({ type: 'service:status', requestId: message.requestId, status: status() }, () => {});
      }
    });
    await supervisor.done;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (process.connected) process.disconnect();
    process.exitCode = supervisor.lastError && supervisor.lastError === 'LOCK_IDENTITY_CHANGED' ? 1 : 0;
  } else if (action === 'status' || action === 'stop') {
    output(await controlService({ home: options.home, action }));
  } else if (action === 'backup') {
    output(await backupSnapshot(options));
  } else if (action === 'verify' && options.snapshotPath) {
    output(await verifySnapshot(options));
  } else if (action === 'restore' && options.snapshotPath && options.destination) {
    output(await restoreSnapshot(options));
  } else {
    output({ commands: ['run [--home PATH] [--config PATH]', 'status [--home PATH]', 'stop [--home PATH]',
      'backup --offline [--home PATH] [--config PATH] [--backup-dir PATH]', 'verify --snapshot PATH',
      'restore --snapshot PATH --destination NEW_EMPTY_PATH'], error: 'INVALID_COMMAND' });
    process.exitCode = 1;
  }
} catch (err) {
  output({ ok: false, error: errorCode(err) });
  process.exitCode = 1;
}
