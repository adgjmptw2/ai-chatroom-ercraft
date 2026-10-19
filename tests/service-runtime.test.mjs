import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  DEFAULT_POLICY, MIN_FREE_BYTES, startSupervisor, controlService, restartDelay,
  acquireServiceLock, servicePaths, backupSnapshot, verifySnapshot, restoreSnapshot,
} from '../lib/service-runtime.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const policy = { maxRestarts: 2, baseDelayMs: 40, maxDelayMs: 80, readyTimeoutMs: 2500,
  healthIntervalMs: 50, healthTimeoutMs: 200, stopTimeoutMs: 500 };
const ownedSupervisors = new Map();
const ownedEntryProcesses = new Map();
async function until(predicate, timeout = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) assert.fail('Timed out waiting for synthetic service');
    await delay(10);
  }
}
async function fixture(t) {
  const drive = await fs.statfs(process.platform === 'win32' ? 'C:\\' : os.tmpdir());
  assert.ok(drive.bavail * drive.bsize > MIN_FREE_BYTES + 2 * 1024 ** 2, '15 GiB development budget plus fixture output');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatroom-service-test-'));
  t.after(async () => {
    for (const { child, exit } of ownedEntryProcesses.get(root) || []) {
      if (child.connected) child.disconnect();
      await exit;
    }
    ownedEntryProcesses.delete(root);
    for (const supervisor of ownedSupervisors.get(root) || []) await supervisor.stop();
    ownedSupervisors.delete(root);
    // Only remove this test's exact generated directory, never a shared target.
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('chatroom-service-test-'));
    assert.equal(await fs.realpath(resolved), resolved);
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await fs.mkdir(path.join(root, 'data', 'notes'), { recursive: true });
  await fs.mkdir(path.join(root, 'workspace', 'images'), { recursive: true });
  const contents = {
    'config.json': '{"port":8321,"synthetic":true}\n', '.env': 'TEST_SECRET=fixture-only\n',
    'data/state.json': '{"room":{"running":true,"sleeping":true}}\n',
    'data/world.json': '{"blocks":{"1,2,3":"wood"}}\n',
    'data/world-plans.json': '{"plans":[{"id":1}]}\n',
    'data/messages.jsonl': '{"text":"안녕"}\n{"text":"test"}\n',
    'data/workspace-meta.json': '{"images/a.png":{"kind":"image"}}\n',
    'data/notes/member.md': 'synthetic private note\n',
    'data/topic-state.json': '{"current":"test"}\n',
    'data/topic-history.jsonl': '{"topic":"previous"}\n',
    'data/admin-auth.json': '{"passwordHash":"synthetic"}\n',
    'workspace/images/a.png': Buffer.from([0, 1, 2, 255]),
  };
  for (const [name, value] of Object.entries(contents)) await fs.writeFile(path.join(root, name), value);
  return { root, contents };
}
async function childFixture(root) {
  const entry = path.join(root, 'synthetic-child.mjs');
  await fs.writeFile(entry, `
import fs from 'node:fs';
import path from 'node:path';
const instanceId = process.env.CHATROOM_SERVICE_INSTANCE;
const home = process.env.CHATROOM_HOME;
const mode = process.env.FIXTURE_MODE || 'healthy';
const send = (value) => { if (process.connected) process.send({instanceId,pid:process.pid,...value},()=>{}); };
const stateFile = path.join(home,'data','state.json');
const initial = fs.readFileSync(stateFile,'utf8');
fs.appendFileSync(path.join(home,'launches.jsonl'), JSON.stringify({at:Date.now(),instanceId,state:initial})+'\\n');
process.on('message', (message) => {
  if (message.type === 'service:health' && mode !== 'unhealthy') {
    send({type:'service:health',requestId:message.requestId,ready:true,roomRunning:true});
  }
  if (message.type === 'shutdown') {
    fs.writeFileSync(path.join(home,'shutdown.json'), JSON.stringify(message));
    if (mode === 'slow-stop') { setTimeout(()=>process.exit(0),300); return; }
    if (message.preserveDesiredState !== true) fs.writeFileSync(stateFile,'WRONG');
    // A delayed world-save flush models the hook required of the parent.
    setTimeout(()=>{ fs.writeFileSync(path.join(home,'flushed.txt'),'yes'); process.exit(0); },20);
  }
});
process.on('disconnect',()=>process.exit(0));
if (mode !== 'no-ready') send({type:'service:ready',protocol:1});
if (mode === 'crash') setTimeout(()=>process.exit(7),40);
if (mode === 'normal-exit') setTimeout(()=>process.exit(0),40);
// Test-only failsafe: no synthetic child can live indefinitely after a failed assertion.
setTimeout(()=>process.exit(0),12000);
`);
  return entry;
}
async function service(t, root, mode = 'healthy', override = {}) {
  const entry = await childFixture(root);
  const supervisor = await startSupervisor({ root, entry, env: { FIXTURE_MODE: mode }, policy: { ...policy, ...override } });
  const owned = ownedSupervisors.get(root) || [];
  owned.push(supervisor);
  ownedSupervisors.set(root, owned);
  return supervisor;
}
const backup = (root, extra = {}) => backupSnapshot({ root, childStopped: true, ...extra });

test('bounded exponential backoff has a lifetime restart cap', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 100].map((n) => restartDelay(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(DEFAULT_POLICY.maxRestarts, 5);
});

test('authenticated status, health, and stop preserve desired running/sleep flags', async (t) => {
  const { root, contents } = await fixture(t);
  const supervisor = await service(t, root);
  await until(() => supervisor.status().health?.ready);
  const status = await controlService({ home: root });
  assert.equal(status.status.state, 'running');
  assert.equal(status.status.childPid, supervisor.child.pid);
  assert.ok(status.status.childInstanceId);
  assert.equal(JSON.stringify(status).includes('token'), false);
  const reply = await controlService({ home: root, action: 'stop' });
  assert.equal(reply.accepted, true);
  await supervisor.done;
  assert.equal(supervisor.restarts, 0);
  assert.equal(await fs.readFile(path.join(root, 'data/state.json'), 'utf8'), contents['data/state.json']);
  assert.equal(await fs.readFile(path.join(root, 'flushed.txt'), 'utf8'), 'yes');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'shutdown.json'))).preserveDesiredState, true);
  assert.equal((await controlService({ home: root })).status.state, 'offline');
});

test('nonzero exits restart with distinct identities, persisted state, and bounded delay', async (t) => {
  const { root, contents } = await fixture(t);
  const supervisor = await service(t, root, 'crash');
  const transitions = [];
  supervisor.on('status', (status) => transitions.push(status));
  await until(() => supervisor.state === 'exhausted');
  const launches = (await fs.readFile(path.join(root, 'launches.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(launches.length, 3);
  assert.equal(new Set(launches.map((v) => v.instanceId)).size, 3);
  assert.ok(launches.every((v) => v.state === contents['data/state.json']));
  assert.ok(launches[1].at - launches[0].at >= 75);
  assert.ok(launches[2].at - launches[1].at >= 110);
  assert.equal(transitions.filter((v) => v.state === 'backoff').length, 2);
  await delay(120);
  assert.equal(supervisor.generation, 3);
  assert.equal((await controlService({ home: root })).status.state, 'exhausted');
});

test('intentional zero exit never restarts; stop closes retained supervisor', async (t) => {
  const { root } = await fixture(t);
  const supervisor = await service(t, root, 'normal-exit');
  await until(() => supervisor.state === 'stopped');
  await delay(150);
  assert.equal(supervisor.generation, 1);
  assert.equal(supervisor.restarts, 0);
  assert.equal((await controlService({ home: root })).status.state, 'stopped');
  await supervisor.stop();
});

test('stop during backoff cancels the queued restart', async (t) => {
  const { root } = await fixture(t);
  const supervisor = await service(t, root, 'crash', { baseDelayMs: 350, maxDelayMs: 350 });
  await until(() => supervisor.state === 'backoff');
  await supervisor.stop();
  await delay(400);
  assert.equal(supervisor.generation, 1);
  assert.equal(supervisor.state, 'closed');
});

test('slow cooperative stop retains ownership without forced termination or second child', async (t) => {
  const { root } = await fixture(t);
  const supervisor = await service(t, root, 'slow-stop', { stopTimeoutMs: 50 });
  await until(() => supervisor.state === 'running');
  const done = supervisor.stop();
  await until(() => supervisor.state === 'stop-timeout');
  assert.ok(supervisor.child.pid);
  await assert.rejects(acquireServiceLock(root), { code: 'SERVICE_LOCKED' });
  assert.equal((await controlService({ home: root })).status.state, 'stop-timeout');
  await done;
  assert.equal(supervisor.generation, 1);
});

test('readiness and heartbeat timeouts request graceful shutdown before bounded recovery', async (t) => {
  for (const mode of ['no-ready', 'unhealthy']) {
    await t.test(mode, async (t) => {
      const { root } = await fixture(t);
      const supervisor = await service(t, root, mode, { maxRestarts: 0, readyTimeoutMs: 400, healthTimeoutMs: 100 });
      await until(() => supervisor.state === 'exhausted');
      assert.equal(supervisor.generation, 1);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, 'shutdown.json'))).reason,
        mode === 'no-ready' ? 'READY_TIMEOUT' : 'HEALTH_TIMEOUT');
      assert.equal(await fs.readFile(path.join(root, 'flushed.txt'), 'utf8'), 'yes');
    });
  }
});

test('one-instance lock excludes a second supervisor and backups, independent of PID reuse', async (t) => {
  const { root } = await fixture(t);
  const supervisor = await service(t, root);
  await assert.rejects(startSupervisor({ root }), { code: 'SERVICE_LOCKED' });
  await assert.rejects(backup(root), { code: 'SERVICE_LOCKED' });
  await supervisor.stop();
  const lock = await acquireServiceLock(root);
  await lock.update({ supervisorPid: 2147483647 });
  await assert.rejects(acquireServiceLock(root), { code: 'SERVICE_LOCKED' });
  await lock.release();
});

test('wrong control token or identity cannot stop a healthy child', async (t) => {
  const { root } = await fixture(t);
  const supervisor = await service(t, root);
  await until(() => supervisor.state === 'running');
  const identity = JSON.parse(await fs.readFile(servicePaths(root).lockFile));
  for (const request of [{ token: '0'.repeat(64), instanceId: identity.instanceId },
    { token: identity.token, instanceId: 'wrong-instance' }]) {
    const socket = net.connect({ host: '127.0.0.1', port: identity.controlPort });
    await once(socket, 'connect');
    socket.write(JSON.stringify({ ...request, action: 'stop' }) + '\n');
    const [bytes] = await once(socket, 'data');
    assert.equal(JSON.parse(bytes).error, 'UNAUTHORIZED');
    socket.destroy();
  }
  assert.equal(supervisor.stopping, false);
});

test('offline worker snapshot is lossless, private, scoped, and restorable to new staging only', async (t) => {
  const { root, contents } = await fixture(t);
  const result = await backup(root);
  assert.equal(result.verified, true);
  assert.equal(result.images, 'existing-external-files-required');
  assert.equal(JSON.stringify(result).includes('sha256'), false);
  assert.equal(JSON.stringify(result).includes('fixture-only'), false);
  const manifest = JSON.parse(await fs.readFile(path.join(result.snapshotPath, 'manifest.json')));
  for (const name of ['.env', 'data/state.json', 'data/world.json', 'data/world-plans.json', 'data/messages.jsonl',
    'data/workspace-meta.json', 'data/notes/member.md', 'data/topic-state.json', 'data/topic-history.jsonl']) {
    assert.ok(manifest.files.some((v) => v.path === name), name);
    assert.deepEqual(await fs.readFile(path.join(result.snapshotPath, 'files', name)), Buffer.from(contents[name]));
  }
  assert.ok(!manifest.files.some((v) => v.path.startsWith('workspace/')));
  assert.deepEqual(await fs.readFile(path.join(root, 'workspace/images/a.png')), contents['workspace/images/a.png']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(result.snapshotPath, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal((await verifySnapshot({ snapshotPath: result.snapshotPath })).fileCount, manifest.files.length);
  const destination = path.join(root, 'restored');
  const restored = await restoreSnapshot({ snapshotPath: result.snapshotPath, destination });
  assert.equal(restored.verified, true);
  assert.equal(await fs.readFile(path.join(destination, '.env'), 'utf8'), contents['.env']);
  assert.equal(await fs.readFile(path.join(destination, 'data/state.json'), 'utf8'), contents['data/state.json']);
  await assert.rejects(restoreSnapshot({ snapshotPath: result.snapshotPath, destination }), { code: 'EEXIST' });
  for (const [name, value] of Object.entries(contents)) assert.deepEqual(await fs.readFile(path.join(root, name)), Buffer.from(value));
});

test('worker backup demands offline confirmation and honors capacity and free-space budgets', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(backupSnapshot({ root }), { code: 'CHILD_STOPPED_REQUIRED' });
  await assert.rejects(backup(root, { minFreeBytes: 0 }), { code: 'INVALID_LIMIT' });
  await assert.rejects(backup(root, { minFreeBytes: Number.MAX_SAFE_INTEGER }), { code: 'DISK_BUDGET' });
  await assert.rejects(backup(root, { maxBytes: 2 }), { code: 'SNAPSHOT_LIMIT' });
  const first = await backup(root, { maxSnapshots: 1 });
  await assert.rejects(backup(root, { maxSnapshots: 1 }), { code: 'SNAPSHOT_CAPACITY' });
  assert.equal((await verifySnapshot({ snapshotPath: first.snapshotPath })).verified, true);
});

test('snapshot copy is independent of hardlinked sources and detects byte corruption', async (t) => {
  const { root, contents } = await fixture(t);
  await fs.link(path.join(root, 'data/messages.jsonl'), path.join(root, 'original-log-alias'));
  const result = await backup(root);
  const copied = path.join(result.snapshotPath, 'files/data/messages.jsonl');
  const bytes = await fs.readFile(copied);
  bytes[0] ^= 1;
  await fs.writeFile(copied, bytes);
  await assert.rejects(verifySnapshot({ snapshotPath: result.snapshotPath }), { code: 'SNAPSHOT_CORRUPT' });
  await assert.rejects(restoreSnapshot({ snapshotPath: result.snapshotPath, destination: path.join(root, 'bad-restore') }), { code: 'SNAPSHOT_CORRUPT' });
  assert.equal(await fs.readFile(path.join(root, 'original-log-alias'), 'utf8'), contents['data/messages.jsonl']);
});

test('manifest corruption and traversal are rejected before any restore write', async (t) => {
  const { root } = await fixture(t);
  const result = await backup(root);
  const manifestFile = path.join(result.snapshotPath, 'manifest.json');
  const raw = await fs.readFile(manifestFile, 'utf8');
  await fs.writeFile(manifestFile, raw + ' ');
  await assert.rejects(verifySnapshot({ snapshotPath: result.snapshotPath }), { code: 'MANIFEST_CORRUPT' });
  const manifest = JSON.parse(raw);
  manifest.files[0].path = '../escape';
  const altered = JSON.stringify(manifest);
  await fs.writeFile(manifestFile, altered);
  await fs.writeFile(path.join(result.snapshotPath, 'manifest.sha256'), createHash('sha256').update(altered).digest('hex') + '\n');
  await assert.rejects(verifySnapshot({ snapshotPath: result.snapshotPath }), { code: 'UNSAFE_PATH' });
});

test('source junctions are rejected without changing their targets', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'separate-notes');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'keep.txt'), 'preserve me');
  await fs.symlink(target, path.join(root, 'data', 'topics'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(backup(root), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'preserve me');
});

test('CLI status uses only its explicit temporary home', async (t) => {
  const { root } = await fixture(t);
  const script = fileURLToPath(new URL('../scripts/service.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, 'status', '--home', root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(JSON.parse(output).status.state, 'offline');
});

test('retained Node entrypoint supports owner status IPC and shuts down on owner disconnect', async (t) => {
  const { root } = await fixture(t);
  const entry = await childFixture(root);
  // Copy only the two owned modules into an isolated fixture layout; never run
  // production server.mjs. The synthetic child becomes this fixture's server.
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'lib'));
  await fs.copyFile(fileURLToPath(new URL('../scripts/service.mjs', import.meta.url)), path.join(root, 'scripts/service.mjs'));
  await fs.copyFile(fileURLToPath(new URL('../lib/service-runtime.mjs', import.meta.url)), path.join(root, 'lib/service-runtime.mjs'));
  await fs.copyFile(entry, path.join(root, 'server.mjs'));
  const child = spawn(process.execPath, [path.join(root, 'scripts/service.mjs'), 'run'], {
    windowsHide: true, env: { ...process.env, CHATROOM_HOME: root, FIXTURE_MODE: 'healthy' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exit = once(child, 'exit');
  ownedEntryProcesses.set(root, [{ child, exit }]);
  let current, reply, output = '', stderr = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => {
    current = message.status;
    if (message.requestId === 'owner-probe') reply = message;
  });
  await until(() => current?.health?.ready);
  child.send({ type: 'service:status', requestId: 'owner-probe' });
  await until(() => reply);
  assert.equal(reply.status.state, 'running');
  child.disconnect();
  const [code] = await exit;
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(output.includes('token'), false);
  assert.equal(await fs.readFile(path.join(root, 'flushed.txt'), 'utf8'), 'yes');
  assert.equal((await controlService({ home: root })).status.state, 'offline');
});

test('restarts reload newly persisted child state instead of a supervisor memory snapshot', async (t) => {
  const { root } = await fixture(t);
  const supervisor = await service(t, root, 'crash', { baseDelayMs: 500, maxDelayMs: 500, maxRestarts: 1 });
  await until(() => supervisor.state === 'backoff');
  const newest = '{"room":{"running":false,"sleeping":true},"revision":2}\n';
  await fs.writeFile(path.join(root, 'data/state.json'), newest);
  await until(() => supervisor.state === 'exhausted');
  const launches = (await fs.readFile(path.join(root, 'launches.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(launches[1].state, newest);
});
