// Local supervision and offline critical-data snapshots. Node built-ins only.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fork, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

export const MIN_FREE_BYTES = 15 * 1024 ** 3;
export const DEFAULT_POLICY = Object.freeze({
  maxRestarts: 5, baseDelayMs: 1000, maxDelayMs: 30000,
  readyTimeoutMs: 60000, healthIntervalMs: 15000, healthTimeoutMs: 10000, stopTimeoutMs: 30000,
});
const MAX_FRAME = 16384;
const SNAPSHOT_LIMITS = { maxBytes: 256 * 1024 ** 2, maxFiles: 5000, maxSnapshots: 3, minFreeBytes: MIN_FREE_BYTES };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const failure = (code) => Object.assign(new Error(code), { code });
export const errorCode = (err) => /^[A-Z][A-Z0-9_]{1,63}$/.test(err?.code || '') ? err.code : 'SERVICE_ERROR';
const reject = (code) => { throw failure(code); };
const send = (child, message) => {
  if (!child?.connected) return false;
  try { child.send(message, () => {}); return true; } catch { return false; }
};
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
function relativeName(name) {
  if (typeof name !== 'string' || !name || name.length > 1000 || /[\\:\x00-\x1f]/.test(name)
      || name.split('/').some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) reject('UNSAFE_PATH');
  return name;
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Check each component: a junction in an ancestor is as unsafe as a leaf symlink.
async function checkedPath(target, { directory = false, missing = false } = {}) {
  const absolute = path.resolve(target), parsed = path.parse(absolute);
  let current = parsed.root, stat;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { stat = await fs.lstat(current); }
    catch (err) { if (missing && err.code === 'ENOENT') return null; throw err; }
    if (stat.isSymbolicLink() || current !== absolute && !stat.isDirectory()) reject('UNSAFE_PATH');
  }
  stat ??= await fs.lstat(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile()) reject('UNSAFE_PATH');
  return stat;
}
async function privateDirectory(dir) {
  const absolute = path.resolve(dir);
  // Validate existing ancestors before recursive mkdir, then validate the result.
  await checkedPath(absolute, { directory: true, missing: true });
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  await checkedPath(absolute, { directory: true });
  return absolute;
}
// Only apply to our dedicated control directory or a newly created snapshot/
// restore directory. Windows ignores POSIX mode bits, so set the DACL explicitly
// BEFORE any token, manifest, or credential copy enters it. Never touch sources.
async function protectPrivateDirectory(dir) {
  await checkedPath(dir, { directory: true });
  if (process.platform !== 'win32') { await fs.chmod(dir, 0o700); return; }
  const script = `
$ErrorActionPreference = 'Stop'
$target = $env:CHATROOM_SERVICE_PRIVATE_DIR
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($owner)
foreach ($sid in @($owner, $system)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$directory = New-Object System.IO.DirectoryInfo($target)
$directory.SetAccessControl($acl)
$actual = $directory.GetAccessControl()
if (!$actual.AreAccessRulesProtected) { throw 'PRIVATE_ACL_FAILED' }
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  $sid = $rule.IdentityReference.Value
  if ($sid -ne $owner.Value -and $sid -ne 'S-1-5-18') { throw 'PRIVATE_ACL_FAILED' }
}
`;
  await new Promise((resolve, rejectPromise) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, maxBuffer: 8192, env: { ...process.env, CHATROOM_SERVICE_PRIVATE_DIR: dir },
    }, (err) => { if (err) rejectPromise(failure('PRIVATE_ACL_FAILED')); else resolve(); });
  });
}
async function smallJson(file, max = MAX_FRAME) {
  const stat = await checkedPath(file);
  if (stat.size > max) reject('INVALID_METADATA');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { reject('INVALID_METADATA'); }
}
async function writePrivate(file, value) {
  const fd = await fs.open(file, 'wx', 0o600);
  try { await fd.writeFile(value); await fd.sync(); } finally { await fd.close(); }
}

export function servicePaths(home) {
  const runtimeDir = path.join(path.resolve(home), 'data', '.service-runtime');
  return { runtimeDir, lockFile: path.join(runtimeDir, 'owner.json') };
}

// Never infer ownership from PID existence, and never steal a stale lock. A stale
// record can represent a still-draining orphan; manual recovery must check both.
export async function acquireServiceLock(home) {
  const { runtimeDir, lockFile } = servicePaths(home);
  await privateDirectory(runtimeDir);
  // Fast rejection avoids repermissioning an active owner's directory. The
  // subsequent wx open remains the authoritative atomic check against races.
  try { await fs.lstat(lockFile); reject('SERVICE_LOCKED'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  await protectPrivateDirectory(runtimeDir);
  let fd;
  try { fd = await fs.open(lockFile, 'wx', 0o600); }
  catch (err) { if (err.code === 'EEXIST') reject('SERVICE_LOCKED'); throw err; }
  const identity = {
    version: 1, instanceId: randomUUID(), token: randomBytes(32).toString('hex'),
    supervisorPid: process.pid, startedAt: new Date().toISOString(), controlPort: null,
  };
  let released = false, writes = Promise.resolve();
  function update(fields) {
    if (released) return Promise.reject(failure('LOCK_RELEASED'));
    writes = writes.then(async () => {
      Object.assign(identity, fields);
      const bytes = Buffer.from(JSON.stringify(identity));
      let position = 0;
      while (position < bytes.length) {
        const { bytesWritten } = await fd.write(bytes, position, bytes.length - position, position);
        if (!bytesWritten) reject('LOCK_WRITE_FAILED');
        position += bytesWritten;
      }
      await fd.truncate(bytes.length);
      await fd.sync();
    });
    return writes;
  }
  try { await update({}); } catch (err) { await fd.close(); throw err; }
  return {
    identity, update,
    async release() {
      if (released) return;
      released = true;
      try { await writes; } catch { await fd.close(); reject('LOCK_WRITE_FAILED'); }
      await fd.close();
      const saved = await smallJson(lockFile);
      if (saved.token !== identity.token || saved.instanceId !== identity.instanceId) reject('LOCK_IDENTITY_CHANGED');
      await fs.unlink(lockFile); // Only our own ephemeral lock; no data cleanup.
    },
  };
}

export function restartDelay(attempt, policy = DEFAULT_POLICY) {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(30, Math.max(0, attempt - 1)));
}

export class ServiceSupervisor extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.home = path.resolve(options.home || options.root);
    this.root = path.resolve(options.root);
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    for (const [key, value] of Object.entries(this.policy)) {
      if (!integer(value, key === 'maxRestarts' ? 0 : 1, key === 'maxRestarts' ? 100 : 3600000)) reject('INVALID_POLICY');
    }
    if (this.policy.baseDelayMs > this.policy.maxDelayMs) reject('INVALID_POLICY');
    this.state = 'new';
    this.restarts = 0;
    this.generation = 0;
    this.child = null;
    this.stopping = false;
    this.sockets = new Set();
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }
  status() {
    return {
      version: 1, state: this.state, supervisorPid: process.pid,
      instanceId: this.lock?.identity.instanceId, startedAt: this.lock?.identity.startedAt,
      childPid: this.child?.pid || null, childInstanceId: this.childInstanceId || null,
      generation: this.generation, restarts: this.restarts, maxRestarts: this.policy.maxRestarts,
      nextRestartAt: this.nextRestartAt || null, lastExit: this.lastExit || null,
      health: this.health || null, lastError: this.lastError || null,
    };
  }
  changed() { this.emit('status', this.status()); }
  persistChild() {
    void this.lock.update({ childPid: this.child?.pid || null, childInstanceId: this.childInstanceId,
      generation: this.generation, lastExit: this.lastExit || null }).catch(() => {
      this.lastError = 'LOCK_WRITE_FAILED'; void this.stop('lock-write-failed');
    });
  }
  async start() {
    if (this.state !== 'new') reject('ALREADY_STARTED');
    this.lock = await acquireServiceLock(this.home);
    this.control = net.createServer((socket) => this.accept(socket));
    this.control.maxConnections = 8;
    try {
      await new Promise((resolve, rejectPromise) => {
        this.control.once('error', rejectPromise);
        this.control.listen({ host: '127.0.0.1', port: this.options.controlPort ?? 0, exclusive: true }, () => {
          this.control.removeListener('error', rejectPromise); resolve();
        });
      });
      this.control.on('error', () => { this.lastError = 'CONTROL_ERROR'; this.stop('control-error'); });
      await this.lock.update({ controlPort: this.control.address().port });
      this.launch();
      return this;
    } catch (err) {
      if (this.control.listening) await new Promise((resolve) => this.control.close(resolve));
      await this.lock.release();
      throw err;
    }
  }
  accept(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let bytes = Buffer.alloc(0), handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_FRAME) { socket.destroy(); return; }
      if (!bytes.includes(10)) return;
      handled = true;
      let message;
      try { message = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString('utf8')); }
      catch { socket.end('{"ok":false,"error":"INVALID_REQUEST"}\n'); return; }
      const token = message?.token;
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
          || !timingSafeEqual(Buffer.from(token), Buffer.from(this.lock.identity.token))
          || message.instanceId !== this.lock.identity.instanceId) {
        socket.end('{"ok":false,"error":"UNAUTHORIZED"}\n'); return;
      }
      if (message.action !== 'status' && message.action !== 'stop') {
        socket.end('{"ok":false,"error":"INVALID_ACTION"}\n'); return;
      }
      socket.end(JSON.stringify({ ok: true, status: this.status(), accepted: message.action === 'stop' }) + '\n');
      if (message.action === 'stop') setImmediate(() => this.stop('local-control'));
    });
  }
  launch() {
    if (this.stopping || this.child) return;
    this.nextRestartAt = null;
    this.state = 'starting';
    this.health = null;
    this.childInstanceId = randomUUID();
    this.generation++;
    const env = {
      ...process.env, ...this.options.env, CHATROOM_HOME: this.home,
      CHATROOM_SERVICE_INSTANCE: this.childInstanceId,
      CHATROOM_SERVICE_SUPERVISOR: this.lock.identity.instanceId,
    };
    if (this.options.configFile) env.CHATROOM_CONFIG = path.resolve(this.options.configFile);
    let child;
    try {
      child = fork(path.resolve(this.options.entry || path.join(this.root, 'server.mjs')), this.options.childArgs || [], {
        cwd: this.root, env, execArgv: [], detached: false, windowsHide: true,
        // Child logs may contain credentials. No implicit on-disk or console log.
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
    } catch { this.onExit(null, 1, null); return; }
    this.child = child;
    this.persistChild();
    child.once('error', () => {
      this.lastError = 'CHILD_PROCESS_ERROR';
      // A spawn failure has no exit event; an IPC error with a live child does.
      if (!child.pid) this.onExit(child, 1, null);
      else { this.state = 'unresponsive'; this.changed(); }
    });
    child.once('exit', (code, signal) => this.onExit(child, code, signal));
    child.on('message', (message) => this.onMessage(child, message));
    child.once('disconnect', () => {
      if (this.child === child && !this.stopping && !this.recovering) {
        this.lastError = 'CHILD_IPC_DISCONNECTED';
        this.state = 'unresponsive'; this.changed();
      }
    });
    this.readyTimer = setTimeout(() => this.recover('READY_TIMEOUT'), this.policy.readyTimeoutMs);
    this.changed();
  }
  onMessage(child, message) {
    if (child !== this.child || message?.instanceId !== this.childInstanceId || message.pid !== child.pid
        || this.stopping || this.recovering) return;
    if (message.type === 'service:ready' && message.protocol === 1 && this.state === 'starting') {
      clearTimeout(this.readyTimer);
      this.state = 'running'; this.lastError = null; this.changed(); this.ping();
    } else if (message.type === 'service:health' && this.pendingHealth
        && message.requestId === this.pendingHealth && message.ready === true) {
      clearTimeout(this.healthDeadline);
      this.pendingHealth = null;
      this.health = { checkedAt: new Date().toISOString(), ready: true, roomRunning: message.roomRunning === true };
      this.changed();
      this.healthTimer = setTimeout(() => this.ping(), this.policy.healthIntervalMs);
    }
  }
  ping() {
    if (!this.child || this.stopping || this.recovering) return;
    this.pendingHealth = randomUUID();
    send(this.child, { type: 'service:health', instanceId: this.childInstanceId, requestId: this.pendingHealth });
    this.healthDeadline = setTimeout(() => this.recover('HEALTH_TIMEOUT'), this.policy.healthTimeoutMs);
  }
  clearChildTimers() {
    for (const name of ['readyTimer', 'healthTimer', 'healthDeadline', 'stopTimer']) clearTimeout(this[name]);
    this.pendingHealth = null;
  }
  shutdownChild(reason) {
    this.clearChildTimers();
    this.state = 'stopping';
    send(this.child, {
      type: 'shutdown', requestId: randomUUID(), instanceId: this.childInstanceId,
      preserveDesiredState: true, reason,
    });
    this.stopTimer = setTimeout(() => {
      if (!this.child) return;
      this.state = 'stop-timeout'; this.lastError = 'STOP_TIMEOUT'; this.changed();
      // Keep ownership and controls. Never abandon/kill a live child or start a second one.
    }, this.policy.stopTimeoutMs);
    this.changed();
  }
  recover(code) {
    if (!this.child || this.stopping || this.recovering) return;
    this.recovering = true; this.lastError = code; this.shutdownChild(code);
  }
  onExit(child, code, signal) {
    if (child !== this.child) return;
    this.clearChildTimers();
    this.child = null;
    this.lastExit = { code, signal, at: new Date().toISOString() };
    this.persistChild();
    const unexpected = this.recovering || code !== 0 || signal !== null;
    this.recovering = false;
    if (this.stopping) { void this.finish(); return; }
    if (!unexpected) { this.state = 'stopped'; this.lastError = null; this.changed(); return; }
    if (this.restarts >= this.policy.maxRestarts) {
      this.state = 'exhausted'; this.changed(); return;
    }
    const delay = restartDelay(++this.restarts, this.policy);
    this.state = 'backoff'; this.nextRestartAt = Date.now() + delay; this.changed();
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.launch(); }, delay);
  }
  stop(reason = 'requested') {
    if (this.stopping) return this.done;
    this.stopping = true;
    clearTimeout(this.restartTimer); this.restartTimer = null; this.nextRestartAt = null;
    if (this.child) this.shutdownChild(reason);
    else void this.finish();
    return this.done;
  }
  async finish() {
    if (this.finishing) return;
    this.finishing = true;
    this.clearChildTimers();
    // Acknowledgements have been queued before stop() is dispatched.
    for (const socket of this.sockets) socket.end();
    if (this.control?.listening) await new Promise((resolve) => {
      this.control.close(resolve);
      for (const socket of this.sockets) socket.destroy();
    });
    try { await this.lock.release(); } catch (err) { this.lastError = errorCode(err); }
    this.state = 'closed'; this.changed(); this.resolveDone(this.status());
  }
}

export async function startSupervisor(options) { return new ServiceSupervisor(options).start(); }

export async function controlService({ home, action = 'status', timeoutMs = 5000 }) {
  let identity;
  try { identity = await smallJson(servicePaths(home).lockFile); }
  catch (err) {
    if (err.code === 'ENOENT' && (action === 'status' || action === 'stop')) {
      return { ok: true, status: { state: 'offline' }, ...(action === 'stop' ? { accepted: true } : {}) };
    }
    throw err;
  }
  if (!integer(identity.controlPort, 1, 65535) || !/^[a-f0-9]{64}$/.test(identity.token || '')
      || typeof identity.instanceId !== 'string') reject('CONTROL_UNAVAILABLE');
  return new Promise((resolve, rejectPromise) => {
    const socket = net.connect({ host: '127.0.0.1', port: identity.controlPort });
    const timer = setTimeout(() => fail('CONTROL_TIMEOUT'), timeoutMs);
    let bytes = Buffer.alloc(0), settled = false;
    function fail(code) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); rejectPromise(failure(code)); }
    socket.on('error', () => fail('CONTROL_UNAVAILABLE'));
    socket.on('end', () => { if (!settled) fail('CONTROL_UNAVAILABLE'); });
    socket.on('connect', () => socket.write(JSON.stringify({ action, token: identity.token, instanceId: identity.instanceId }) + '\n'));
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_FRAME) { fail('INVALID_RESPONSE'); return; }
      if (!bytes.includes(10)) return;
      let response;
      try { response = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString('utf8')); }
      catch { fail('INVALID_RESPONSE'); return; }
      if (!response.ok || response.status?.instanceId !== identity.instanceId) { fail('IDENTITY_MISMATCH'); return; }
      settled = true; clearTimeout(timer); socket.end(); resolve(response);
    });
  });
}

function snapshotOptions(options) {
  const result = { ...SNAPSHOT_LIMITS, ...options };
  for (const [name, max] of Object.entries({ maxBytes: 1024 ** 4, maxFiles: 10000, maxSnapshots: 100, minFreeBytes: Number.MAX_SAFE_INTEGER })) {
    if (!integer(result[name], name === 'minFreeBytes' ? MIN_FREE_BYTES : 1, max)) reject('INVALID_LIMIT');
  }
  return result;
}
async function budget(dir, bytes, minFreeBytes) {
  const stat = await fs.statfs(dir);
  if (stat.bavail * stat.bsize < minFreeBytes + bytes + 4 * 1024 ** 2) reject('DISK_BUDGET');
  // Development backup/restore writes on another volume still respect the C: budget.
  if (process.platform === 'win32') {
    const c = await fs.statfs('C:\\');
    if (c.bavail * c.bsize < minFreeBytes) reject('DISK_BUDGET');
  }
}
const signature = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

async function inventory(options) {
  const { root, home, configFile, maxFiles, maxBytes } = options;
  const files = [], missing = [], seen = new Set();
  let totalBytes = 0, directories = 0;
  async function add(source, rel, required = false, depth = 0) {
    relativeName(rel);
    if (depth > 20) reject('TOO_MANY_DIRECTORIES');
    let stat;
    try { stat = await fs.lstat(source); }
    catch (err) { if (err.code === 'ENOENT' && !required) { missing.push(rel); return; } throw err; }
    if (stat.isSymbolicLink()) reject('UNSAFE_PATH');
    if (stat.isDirectory()) {
      await checkedPath(source, { directory: true });
      if (++directories > 1000) reject('TOO_MANY_DIRECTORIES');
      for await (const item of await fs.opendir(source)) await add(path.join(source, item.name), `${rel}/${item.name}`, true, depth + 1);
    } else {
      await checkedPath(source);
      const key = rel.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      totalBytes += stat.size;
      if (files.length >= maxFiles || totalBytes > maxBytes) reject('SNAPSHOT_LIMIT');
      files.push({ source, path: rel, size: stat.size, signature: signature(stat) });
    }
  }
  await add(configFile || path.join(root, 'config.json'), 'config.json', true);
  await add(path.join(root, '.env'), '.env');
  for (const name of ['state.json', 'world.json', 'world-plans.json', 'living.json', 'messages.jsonl', 'workspace-meta.json',
    'notes', 'image-aliases.json', 'admin-auth.json', 'admin-password.txt', 'usage.jsonl', 'hive-usage.jsonl']) {
    await add(path.join(home, 'data', name), `data/${name}`, name === 'state.json');
  }
  const dataDir = path.join(home, 'data');
  await checkedPath(dataDir, { directory: true });
  for await (const entry of await fs.opendir(dataDir)) {
    if (/^topics?(?:[-._]|$)/i.test(entry.name)) await add(path.join(dataDir, entry.name), `data/${entry.name}`);
  }
  for (const rel of options.extraDataPaths || []) {
    relativeName(rel);
    if (!rel.startsWith('data/') || rel.startsWith('data/.service-runtime')) reject('UNSAFE_PATH');
    await add(path.join(home, rel), rel, true);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes, missing: missing.sort() };
}

// Copies are independent bytes, never links. Reading an existing hardlink is safe;
// no source chmod, truncate, rename, deletion, or write occurs here.
async function readAndHash(source, destination, expectedSize) {
  const initial = await checkedPath(source);
  const input = await fs.open(source, 'r');
  let output;
  try {
    const before = await input.stat();
    if (signature(initial) !== signature(before) || before.size !== expectedSize) reject('SOURCE_CHANGED');
    if (destination) {
      await privateDirectory(path.dirname(destination));
      output = await fs.open(destination, 'wx', 0o600);
    }
    const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
    let position = 0;
    while (position < expectedSize) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
      if (!bytesRead) reject('SOURCE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, position + offset);
          if (!bytesWritten) reject('COPY_FAILED');
          offset += bytesWritten;
        }
      }
      position += bytesRead;
    }
    if (signature(before) !== signature(await input.stat()) || signature(before) !== signature(await checkedPath(source))) reject('SOURCE_CHANGED');
    if (output) await output.sync();
    return hash.digest('hex');
  } finally { await input.close(); if (output) await output.close(); }
}

async function verifyInternal(options) {
  const snapshotPath = path.resolve(options.snapshotPath);
  await checkedPath(snapshotPath, { directory: true });
  const manifestFile = path.join(snapshotPath, 'manifest.json');
  const metadataStat = await checkedPath(manifestFile);
  if (metadataStat.size > 4 * 1024 ** 2) reject('INVALID_MANIFEST');
  const digestFile = path.join(snapshotPath, 'manifest.sha256');
  if ((await checkedPath(digestFile)).size !== 65) reject('INVALID_MANIFEST');
  const raw = await fs.readFile(manifestFile);
  if ((await fs.readFile(digestFile, 'utf8')).trim() !== sha(raw)) reject('MANIFEST_CORRUPT');
  let manifest;
  try { manifest = JSON.parse(raw); } catch { reject('INVALID_MANIFEST'); }
  if (manifest.format !== 'ai-chatroom-critical-snapshot' || manifest.version !== 1
      || manifest.consistency !== 'child-stopped' || !Array.isArray(manifest.files)
      || manifest.files.length > options.maxFiles) reject('INVALID_MANIFEST');
  const names = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    relativeName(file.path);
    if (file.path === 'manifest.json' || file.path === 'manifest.sha256' || names.has(file.path.toLowerCase())
        || !integer(file.size, 0, options.maxBytes) || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) reject('INVALID_MANIFEST');
    names.add(file.path.toLowerCase());
    totalBytes += file.size;
    if (totalBytes > options.maxBytes) reject('SNAPSHOT_LIMIT');
    const value = await readAndHash(path.join(snapshotPath, 'files', file.path), null, file.size);
    if (value !== file.sha256) reject('SNAPSHOT_CORRUPT');
  }
  if (!names.has('config.json') || !names.has('data/state.json') || totalBytes !== manifest.totalBytes) reject('INVALID_MANIFEST');
  return { manifest, snapshotPath, totalBytes };
}
function receipt(result) {
  return { snapshotPath: result.snapshotPath, verified: true, fileCount: result.manifest.files.length,
    totalBytes: result.totalBytes, scope: 'critical-data-only', images: 'existing-external-files-required' };
}

async function backupInternal(input) {
  const options = snapshotOptions(input);
  if (options.childStopped !== true) reject('CHILD_STOPPED_REQUIRED');
  options.root = path.resolve(options.root);
  options.home = path.resolve(options.home || options.root);
  options.configFile = options.configFile && path.resolve(options.configFile);
  const lock = await acquireServiceLock(options.home);
  try {
    const backupDir = path.resolve(options.backupDir || path.join(options.home, 'backups', 'service'));
    if (inside(path.join(options.home, 'data'), backupDir) || inside(path.join(options.home, 'workspace'), backupDir)
        || inside(path.join(options.root, 'public'), backupDir)) reject('UNSAFE_BACKUP_DIRECTORY');
    await privateDirectory(backupDir);
    let slots = 0;
    for await (const entry of await fs.opendir(backupDir)) if (entry.name.startsWith('snapshot-')) slots++;
    if (slots >= options.maxSnapshots) reject('SNAPSHOT_CAPACITY');
    const before = await inventory(options);
    // Allow for allocation-unit rounding, bounded directories, and the manifest.
    await budget(backupDir, before.totalBytes + (before.files.length + 1000) * 4096, options.minFreeBytes);
    const estimate = JSON.stringify({ files: before.files.map((file) => ({ path: file.path, size: file.size, sha256: '0'.repeat(64) })), missingOptional: before.missing });
    if (Buffer.byteLength(estimate) > 3 * 1024 ** 2) reject('METADATA_LIMIT');
    const id = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const pending = path.join(backupDir, `${id}.pending`), snapshotPath = path.join(backupDir, id);
    await fs.mkdir(pending, { mode: 0o700 });
    await protectPrivateDirectory(pending);
    const entries = [];
    for (const file of before.files) {
      await budget(backupDir, file.size, options.minFreeBytes);
      const digest = await readAndHash(file.source, path.join(pending, 'files', file.path), file.size);
      entries.push({ path: file.path, size: file.size, sha256: digest });
    }
    const after = await inventory(options);
    if (JSON.stringify(before) !== JSON.stringify(after)) reject('SOURCE_CHANGED');
    // Re-read source hashes after all copies to detect in-place changes as well.
    for (let i = 0; i < before.files.length; i++) {
      if (await readAndHash(before.files[i].source, null, before.files[i].size) !== entries[i].sha256) reject('SOURCE_CHANGED');
    }
    const manifest = {
      format: 'ai-chatroom-critical-snapshot', version: 1, createdAt: new Date().toISOString(),
      consistency: 'child-stopped', scope: 'critical-data-only',
      excluded: ['workspace/', 'public/assets/', 'assets/', 'data/logs/', 'runtime dependencies and source code'],
      images: 'Keep existing workspace images and assets; this snapshot alone is not a full-machine restore.',
      totalBytes: before.totalBytes, missingOptional: before.missing, files: entries,
    };
    const raw = JSON.stringify(manifest) + '\n';
    await writePrivate(path.join(pending, 'manifest.json'), raw);
    await writePrivate(path.join(pending, 'manifest.sha256'), sha(raw) + '\n');
    await verifyInternal({ ...options, snapshotPath: pending });
    await fs.rename(pending, snapshotPath);
    return receipt({ manifest, snapshotPath, totalBytes: before.totalBytes });
  } finally { await lock.release(); }
}

async function restoreInternal(input) {
  const options = snapshotOptions(input);
  const result = await verifyInternal(options);
  const destination = path.resolve(options.destination);
  if (inside(result.snapshotPath, destination) || inside(destination, result.snapshotPath)) reject('UNSAFE_RESTORE_DIRECTORY');
  await checkedPath(path.dirname(destination), { directory: true });
  await budget(path.dirname(destination), result.totalBytes + (result.manifest.files.length + 1000) * 4096, options.minFreeBytes);
  // Fresh staging destination only. Never overwrite or rotate authoritative data.
  await fs.mkdir(destination, { mode: 0o700 });
  await protectPrivateDirectory(destination);
  for (const file of result.manifest.files) {
    await budget(destination, file.size, options.minFreeBytes);
    const target = path.join(destination, file.path);
    if (await readAndHash(path.join(result.snapshotPath, 'files', file.path), target, file.size) !== file.sha256
        || await readAndHash(target, null, file.size) !== file.sha256) reject('RESTORE_CORRUPT');
  }
  return { ...receipt(result), destination };
}

// Worker threads keep copying and SHA-256 off the supervisor/server event loop.
// Only offline callers may use backupSnapshot; its shared lock excludes run/start.
function workerTask(operation, options) {
  return new Promise((resolve, rejectPromise) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { serviceRuntime: 1, operation, options }, execArgv: [] });
    let result;
    worker.once('message', (message) => { result = message; });
    worker.once('error', () => rejectPromise(failure('BACKUP_WORKER_ERROR')));
    worker.once('exit', (code) => {
      if (code !== 0 || !result) rejectPromise(failure('BACKUP_WORKER_EXIT'));
      else if (!result.ok) rejectPromise(failure(result.error));
      else resolve(result.value);
    });
  });
}
export const backupSnapshot = (options) => workerTask('backup', options);
export const verifySnapshot = (options) => workerTask('verify', options);
export const restoreSnapshot = (options) => workerTask('restore', options);

if (!isMainThread && workerData?.serviceRuntime === 1) {
  try {
    const { operation, options } = workerData;
    let value;
    if (operation === 'backup') value = await backupInternal(options);
    else if (operation === 'verify') value = receipt(await verifyInternal(snapshotOptions(options)));
    else if (operation === 'restore') value = await restoreInternal(options);
    else reject('INVALID_OPERATION');
    parentPort.postMessage({ ok: true, value });
  } catch (err) { parentPort.postMessage({ ok: false, error: errorCode(err) }); }
}
