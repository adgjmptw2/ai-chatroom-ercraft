// Runs a byte-for-byte copy of the actual server with synthetic runtime data.
// Only the copied provider/usage modules are replaced. No live config, .env,
// runtime data, user profile, provider credential, or existing process is used.
// Optional per-member scripted JSON actions are consumed once; an empty or
// missing queue retains the original deny policy, never a default AI response.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tinyPng } from '../privacy-fixtures.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TESTS = path.join(ROOT, 'tests');
const REQUEST_MS = 5000;
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(value).digest('hex');

const ADAPTER_STUB = `
const ids = ['claude', 'gpt', 'deepseek', 'gemini'];
const denied = (op) => globalThis.__fixtureDeny('provider:' + op);
export const running = new Set();
export const spawnOpts = () => denied('spawnOpts');
export const onPath = () => denied('onPath');
export const killTree = () => denied('killTree');
export const run = () => denied('run');
export function killAll() {}
export class Adapters {
  constructor(home, cfg) { this.root = home; this.cfg = cfg; this.bins = {}; }
  available() { return Object.fromEntries(ids.map(id => [id, true])); }
  canSee() { return false; }
  maxPromptChars() { return 100000; }
  async chat(id, brief, turn, opts = {}) {
    const queue = globalThis.__fixtureReplies[id];
    if (!ids.includes(id) || !Array.isArray(queue) || !queue.length) return denied('chat');
    const reply = queue.shift();
    globalThis.__fixtureChats.push({ id, brief, turn, opts });
    return { ok: true, text: typeof reply === 'string' ? reply : JSON.stringify(reply), ms: 1, detail: '' };
  }
  plan() { return denied('plan'); }
  image() { return denied('image'); }
  describeImage() { return denied('describeImage'); }
}
`;

const USAGE_STUB = `
export class UsageMonitor {
  constructor(home, bins, { onUpdate } = {}) {
    this.onUpdate = onUpdate; this.lastPoll = 0; this.polling = false; this.polls = 0;
    globalThis.__fixtureUsage = this;
  }
  view() {
    return Object.fromEntries(['claude', 'gpt', 'deepseek', 'gemini'].map(id => [id, {
      ok: true, at: Date.now(), model: 'fixture-private-model-v9', account: 'fixture-account-private',
      plan: 'fixture-quota-private', windows: [{ name: 'fixture-window-private', remainingPct: 87.654321, resetsAt: 1999999999 }],
    }]));
  }
  pollAll() { this.polls++; this.lastPoll = Date.now(); this.onUpdate?.(this.view()); return Promise.resolve(); }
}
`;

// The guard is installed BEFORE importing the copied server. Loopback inbound
// HTTP is real; all outbound sockets, DNS, fetch and subprocess attempts fail.
// IPC only supplies fixture metrics, usage events, and bounded test teardown.
const BOOTSTRAP = `
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const violations = [];
globalThis.__fixtureReplies = JSON.parse(fs.readFileSync(new URL('./fixture-replies.json', import.meta.url), 'utf8'));
globalThis.__fixtureChats = [];
globalThis.__fixtureDeny = (operation) => {
  if (violations.length < 64) violations.push(operation);
  process.send?.({ type: 'fixture:violation', operation });
  throw new Error('Fixture forbids ' + operation);
};
const deny = operation => () => globalThis.__fixtureDeny(operation);
net.Socket.prototype.connect = deny('outbound:socket');
for (const method of ['connect', 'createConnection']) net[method] = deny('outbound:net.' + method);
tls.connect = deny('outbound:tls');
for (const module of [http, https]) for (const method of ['request', 'get']) module[method] = deny('outbound:http.' + method);
for (const method of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) {
  dns[method] = deny('outbound:dns.' + method);
  dns.promises[method] = deny('outbound:dns.promises.' + method);
}
// Node's listener calls dns.lookup even for a numeric host. Resolve that one
// literal locally, without invoking the OS resolver or relaxing egress guards.
dns.lookup = (host, options, callback) => {
  if (host !== '127.0.0.1') return globalThis.__fixtureDeny('outbound:dns.lookup');
  if (typeof options === 'function') { callback = options; options = {}; }
  queueMicrotask(() => options?.all ? callback(null, [{ address: host, family: 4 }]) : callback(null, host, 4));
};
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = deny('cli:' + method);
globalThis.fetch = deny('outbound:fetch');
globalThis.WebSocket = class { constructor() { globalThis.__fixtureDeny('outbound:websocket'); } };
syncBuiltinESMExports();
const servers = new Set();
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  servers.add(this);
  this.once('listening', () => process.send?.({ type: 'fixture:listening', address: this.address() }));
  return listen.apply(this, args);
};
const watchdog = setTimeout(() => process.exit(91), Object.keys(globalThis.__fixtureReplies).length ? 60000 : 40000);
watchdog.unref();
process.on('message', async (message) => {
  if (!message?.type?.startsWith('fixture:')) return;
  if (message.type === 'fixture:usage') await globalThis.__fixtureUsage?.pollAll();
  if (message.type === 'fixture:metrics' || message.type === 'fixture:usage') {
    process.send?.({ type: 'fixture:reply', requestId: message.requestId,
      rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed,
      violations, usagePolls: globalThis.__fixtureUsage?.polls || 0, guardInstalled: true,
      scriptedCalls: globalThis.__fixtureChats,
      scriptedRemaining: Object.fromEntries(Object.entries(globalThis.__fixtureReplies).map(([id, queue]) => [id, queue.length])) });
  }
  if (message.type === 'fixture:stop') {
    // This is fixture cleanup, not a claim about application graceful shutdown.
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    process.exit(0);
  }
});
try { await import('./server.mjs'); }
catch (error) { console.error(error.stack); process.exit(92); }
`;

function inputs() {
  const files = ['server.mjs', 'LICENSE'];
  function walk(relative, allowed) {
    for (const entry of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      const rel = path.join(relative, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Fixture must not follow source links: ${rel}`);
      if (entry.isDirectory()) walk(rel, allowed);
      else if (allowed(rel)) files.push(rel);
    }
  }
  walk('lib', (rel) => rel.endsWith('.mjs') || ['persona-meme-bank.json', 'eternal-return-lore.json'].includes(path.basename(rel)));
  // Actual page/code assets only. A synthetic portrait is seeded below; local
  // character artwork and live workspace files never enter this fixture.
  for (const entry of fs.readdirSync(path.join(ROOT, 'public'), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:html|js|css|ico|png)$/.test(entry.name)) files.push(path.join('public', entry.name));
  }
  return files.filter((rel) => fs.existsSync(path.join(ROOT, rel)));
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function serviceFixture(t, { messageCount = 2105, gateway = false,
  scriptedReplies = {}, householdFlow, worldSnapshot, speed, imageGen = false, prepareHome } = {}) {
  assert.ok(scriptedReplies && typeof scriptedReplies === 'object' && !Array.isArray(scriptedReplies));
  let scriptedCount = 0;
  for (const [id, queue] of Object.entries(scriptedReplies)) {
    assert.ok(['claude', 'gpt', 'deepseek', 'gemini'].includes(id), `Unknown scripted member: ${id}`);
    assert.ok(Array.isArray(queue), `Scripted replies for ${id} must be a queue`);
    assert.ok(queue.every(reply => typeof reply === 'string' || reply && typeof reply === 'object' && !Array.isArray(reply)));
    scriptedCount += queue.length;
  }
  assert.ok(scriptedCount <= 64, 'Scripted call trace must stay bounded');
  assert.ok(speed === undefined || ['slow', 'normal', 'fast'].includes(speed));
  assert.equal(typeof imageGen, 'boolean');
  const files = inputs();
  const sourceBytes = files.reduce((sum, rel) => sum + fs.statSync(path.join(ROOT, rel)).size, 0);
  const disk = fs.statfsSync(process.platform === 'win32' ? 'C:\\' : TESTS);
  assert.ok(disk.bavail * disk.bsize > 15 * 1024 ** 3 + sourceBytes + 8 * 1024 ** 2, '15 GiB disk reserve plus fixture budget');
  const root = fs.mkdtempSync(path.join(TESTS, '.service-integration-'));
  const home = path.join(root, 'synthetic-home');
  const sockets = new Set();
  const requests = new Set();
  const failures = [];
  let child, exit, stopped = false, output = '', requestId = 0;
  const instanceId = randomUUID(), serviceMessages = [];
  const replies = new EventEmitter();
  const started = performance.now();
  t.after(async () => {
    for (const connection of sockets) connection.close();
    for (const request of requests) request.destroy();
    if (child && !stopped) {
      if (child.connected) child.send({ type: 'shutdown', instanceId, preserveDesiredState: true }, () => {});
      let timer;
      await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
      if (!stopped) {
        // Only our freshly forked, owned fixture child can be force terminated.
        child.kill('SIGKILL');
        await Promise.race([exit, pause(1500)]);
      }
    }
    assert.ok(!child || stopped, 'fixture process exited before deleting its checkout');
    assert.equal(path.dirname(path.resolve(root)), TESTS);
    assert.ok(path.basename(root).startsWith('.service-integration-'));
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'fixture must never attempt provider, network, or CLI operations');
  });
  for (const rel of files) {
    const source = path.join(ROOT, rel), target = path.join(root, rel);
    assert.ok(fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  const serverHash = hash(fs.readFileSync(path.join(root, 'server.mjs')));
  fs.writeFileSync(path.join(root, 'lib', 'agents.mjs'), ADAPTER_STUB);
  fs.writeFileSync(path.join(root, 'lib', 'usage.mjs'), USAGE_STUB);
  fs.writeFileSync(path.join(root, 'fixture-bootstrap.mjs'), BOOTSTRAP);
  // Routing/privacy tests need an image response, not licensed character art.
  // The public source checkout deliberately ships no character illustrations.
  const portrait = path.join(root, 'public', 'assets', 'characters', 'gpt', 'avatar.png');
  fs.mkdirSync(path.dirname(portrait), { recursive: true });
  fs.writeFileSync(portrait, tinyPng());
  fs.writeFileSync(path.join(root, 'fixture-replies.json'), JSON.stringify(scriptedReplies));
  const data = path.join(home, 'data');
  fs.mkdirSync(data, { recursive: true });
  const records = Array.from({ length: messageCount }, (_, i) => ({
    id: i + 1, ts: 1700000000000 + i, from: i % 2 ? 'gpt' : 'claude',
    text: `합성 대화 ${i + 1}`, model: 'fixture-private-model-v9', provider: 'fixture-provider-private',
    tokens: 1357911, remainingPct: 87.654321, ...(i === 1 ? { attach: { path: 'images/synthetic.png', desc: '처음 설명' } } : {}),
  }));
  records.push({ kind: 'react', target: 2, by: 'claude', emoji: '🌷' }, { kind: 'desc', target: 2, text: '뒤늦은 설명 🐱' });
  fs.writeFileSync(path.join(data, 'messages.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
    room: { running: false, sleeping: true, calls: 2468135 },
    ...(householdFlow === undefined ? {} : { householdFlow }),
  }));
  fs.writeFileSync(path.join(data, 'world.json'), JSON.stringify(worldSnapshot ?? {
    blocks: { '12,1,12': 'planks' }, avatars: { gpt: { x: 12, z: 14 } }, signs: {}, custom: {}, log: [],
  }));
  if (prepareHome) await prepareHome(home);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    port, host: '127.0.0.1', basePath: '/chat', language: 'ko',
    ...(gateway ? { publicGateway: true, publicOrigin: 'https://ercraft.net' } : {}),
    roomName: '합성 검증실', userName: '관리자', imageGen, constructionEnabled: false,
    ...(speed === undefined ? {} : { speed }),
    dev: { enabled: false }, external: { enabled: false }, spark: { enabled: false }, webSearch: false,
    topics: { enabled: true, sources: [] }, network: { maxClients: 100, perAddress: 100, maxRequests: 64 },
    usagePollSec: 3600, usagePollIdleSec: 3600,
    agents: Object.fromEntries(['claude', 'gpt', 'deepseek', 'gemini'].map((id) => [id, { model: 'fixture-private-model-v9', boost: null }])),
  };
  const configFile = path.join(root, 'fixture-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const profile = path.join(root, 'synthetic-profile');
  fs.mkdirSync(profile);
  const env = { CHATROOM_HOME: home, CHATROOM_CONFIG: configFile, CHATROOM_SERVICE_INSTANCE: instanceId, HOME: profile, USERPROFILE: profile,
    APPDATA: profile, LOCALAPPDATA: profile, TEMP: profile, TMP: profile, LANG: 'C.UTF-8' };
  if (gateway) env.CHATROOM_PROXY_TOKEN = 'fixture-proxy-'.repeat(4);
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
  child = fork(path.join(root, 'fixture-bootstrap.mjs'), [], {
    cwd: root, env, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  exit = new Promise((resolve) => child.once('exit', (code, signal) => { stopped = true; resolve({ code, signal }); replies.emit('exit'); }));
  child.on('error', (error) => { output += error.message; replies.emit('child-error', error); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-16384); });
  child.on('message', (message) => {
    if (message.type === 'fixture:violation') failures.push(message.operation);
    if (message.type?.startsWith('service:') && serviceMessages.length < 64) serviceMessages.push(message);
    replies.emit(message.type, message);
  });
  function waitReply(type, match = () => true, timeout = REQUEST_MS) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); replies.off(type, onReply); replies.off('exit', onExit); replies.off('child-error', onError);
        error ? reject(error) : resolve(value);
      };
      const onReply = (value) => { if (match(value)) finish(null, value); };
      const onExit = () => finish(new Error(`Fixture exited before ${type}: ${output}`));
      const onError = (error) => finish(error);
      const timer = setTimeout(() => finish(new Error(`Fixture timed out waiting for ${type}: ${output}`)), timeout);
      replies.on(type, onReply); replies.once('exit', onExit); replies.once('child-error', onError);
      if (stopped) onExit();
    });
  }
  const [ready, listening] = await Promise.all([
    waitReply('service:ready', () => true, 10000),
    waitReply('fixture:listening', () => true, 10000),
  ]);
  assert.equal(ready.protocol, 1);
  assert.equal(ready.instanceId, instanceId);
  assert.equal(ready.pid, child.pid);
  assert.equal(listening.address.port, port);
  assert.equal(listening.address.address, '127.0.0.1');
  t.diagnostic(`Copied server SHA256 ${serverHash}; ${sourceBytes} source bytes; ready in ${(performance.now() - started).toFixed(1)} ms.`);

  function request(route, { method = 'GET', body, cookie, origin: suppliedOrigin, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const h = { ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(suppliedOrigin ? { Origin: suppliedOrigin } : {}), ...headers };
      const req = http.request(origin + route, { method, headers: h, agent: false }, (res) => {
        const chunks = []; let bytes = 0;
        res.on('data', (chunk) => { bytes += chunk.length; if (bytes > 4 * 1024 ** 2) req.destroy(new Error('Fixture response limit')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          clearTimeout(timer);
          const buffer = Buffer.concat(chunks), text = buffer.toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json, buffer });
        });
      });
      const timer = setTimeout(() => req.destroy(new Error(`HTTP ${method} ${route} timed out`)), REQUEST_MS);
      requests.add(req);
      req.on('error', (error) => { clearTimeout(timer); reject(error); });
      req.on('close', () => { clearTimeout(timer); requests.delete(req); });
      req.end(data);
    });
  }

  async function ipc(type) {
    const id = ++requestId;
    const response = waitReply('fixture:reply', (message) => message.requestId === id);
    child.send({ type, requestId: id });
    return response;
  }

  function openSse(cookie) {
    return new Promise((resolve, reject) => {
      const req = http.get(origin + '/chat/events', { agent: false, headers: { Accept: 'text/event-stream', ...(cookie ? { Cookie: cookie } : {}) } });
      requests.add(req);
      const timeout = setTimeout(() => req.destroy(new Error('SSE response timed out')), REQUEST_MS);
      req.on('error', (error) => { clearTimeout(timeout); reject(error); });
      req.once('close', () => requests.delete(req));
      req.once('response', (res) => {
        clearTimeout(timeout);
        const bus = new EventEmitter(), events = [];
        let text = '', pending = '', bytes = 0, closed = false;
        const connection = {
          status: res.statusCode, headers: res.headers, events, localPort: req.socket.localPort,
          get text() { return text; },
          close() { res.destroy(); req.destroy(); },
          waitFor(type, predicate = () => true, after = 0) {
            const found = events.slice(after).find((event) => event.type === type && predicate(event.data));
            if (found) return Promise.resolve(found);
            return new Promise((yes, no) => {
              const finish = (error, event) => { clearTimeout(timer); bus.off('event', observe); bus.off('close', onClose); error ? no(error) : yes(event); };
              const observe = (event) => { if (event.type === type && predicate(event.data)) finish(null, event); };
              const onClose = () => finish(new Error(`SSE closed before ${type}`));
              const timer = setTimeout(() => finish(new Error(`SSE ${type} timed out; received ${events.map(e => e.type).join(',')}`)), REQUEST_MS);
              bus.on('event', observe); bus.once('close', onClose);
              if (closed) onClose();
            });
          },
        };
        sockets.add(connection);
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 1024 ** 2 || events.length >= 2000) { failures.push('fixture:SSE-buffer-limit'); connection.close(); return; }
          text += chunk; pending += chunk;
          for (let at; (at = pending.indexOf('\n\n')) !== -1;) {
            const frame = pending.slice(0, at); pending = pending.slice(at + 2);
            const type = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (type && data) {
              try { const event = { type, data: JSON.parse(data) }; events.push(event); bus.emit('event', event); }
              catch { failures.push('fixture:invalid-SSE-JSON'); connection.close(); }
            }
          }
        });
        res.on('error', () => {});
        res.once('close', () => { closed = true; sockets.delete(connection); bus.emit('close'); });
        resolve(connection);
      });
    });
  }

  return { root, home, data, origin, messageCount, serverHash, request, openSse, ready, instanceId, serviceMessages,
    metrics: () => ipc('fixture:metrics'), emitUsage: () => ipc('fixture:usage'),
    sendService(message) { child.send(message); },
    async health() {
      const id = ++requestId;
      const response = waitReply('service:health', (message) => message.requestId === id);
      child.send({ type: 'service:health', instanceId, requestId: id });
      return response;
    },
    async shutdown({ disconnect = false } = {}) {
      const start = performance.now();
      if (disconnect) child.disconnect();
      else child.send({ type: 'shutdown', instanceId, requestId: ++requestId, preserveDesiredState: true });
      let timer;
      try {
        const result = await Promise.race([exit, new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Application graceful shutdown timed out: ${output}`)), REQUEST_MS);
        })]);
        return { ...result, durationMs: performance.now() - start };
      } finally { clearTimeout(timer); }
    },
    async login({ headers = {}, publicOrigin = origin } = {}) {
      const password = fs.readFileSync(path.join(data, 'admin-password.txt'), 'utf8').trim();
      const response = await request('/chat/api/admin/login', { method: 'POST', origin: publicOrigin, headers, body: { password } });
      assert.equal(response.status, 200, 'synthetic admin login');
      const header = response.headers['set-cookie']?.[0];
      assert.ok(header, 'login sends a cookie');
      return { cookie: header.split(';')[0], header, response };
    },
  };
}
