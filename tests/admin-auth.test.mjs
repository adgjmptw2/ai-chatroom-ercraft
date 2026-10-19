import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { AdminAuth } from '../lib/admin-auth.mjs';

const LOCAL = 'http://localhost:8321';
const IP_LOCAL = 'http://127.0.0.1:8321';
const HTTPS = 'https://room.example';
const VIEWER = { role: 'viewer', authenticated: false };
const ADMIN = { role: 'admin', authenticated: true };
const sha = (text) => createHash('sha256').update(text).digest('hex');

function request({ origin = LOCAL, host = 'localhost:8321', ip = '127.0.0.1', encrypted = false,
  type = 'application/json', cookie, method = 'POST', ...extra } = {}) {
  return { method, socket: { remoteAddress: ip, encrypted },
    headers: { origin, host, 'content-type': type, ...(cookie === undefined ? {} : { cookie }) }, ...extra };
}

function homeFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chatroom-admin-auth-test-'));
  t.after(() => {
    // This fixture owns only this verified direct child of the temporary directory.
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('ai-chatroom-admin-auth-test-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function fixture(t, options = {}) {
  const home = homeFixture(t);
  const settings = { allowedOrigins: [LOCAL, IP_LOCAL, HTTPS], ...options };
  const auth = new AdminAuth(home, settings);
  const passwordFile = path.join(home, 'data', 'admin-password.txt');
  const stateFile = path.join(home, 'data', 'admin-auth.json');
  return { home, auth, settings, passwordFile, stateFile,
    password: fs.readFileSync(passwordFile, 'utf8').trim(),
    restart: () => new AdminAuth(home, settings) };
}

function login(f, req = request()) {
  const result = f.auth.login(req, f.password);
  assert.equal(result.ok, true);
  return { result, cookie: result.cookie.split(';')[0] };
}

function clock(t) { t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 }); }

test('bootstrap writes one high-entropy password and only a validated hash in ignored data/', (t) => {
  const f = fixture(t);
  assert.equal(Buffer.from(f.password, 'base64url').length, 32);
  assert.equal(Buffer.from(f.password, 'base64url').toString('base64url'), f.password);
  const originalPassword = fs.readFileSync(f.passwordFile, 'utf8');
  const originalState = fs.readFileSync(f.stateFile, 'utf8');
  assert.deepEqual(JSON.parse(originalState), { version: 1, algorithm: 'sha256', passwordHash: sha(f.password) });
  assert.equal(originalState.includes(f.password), false);
  f.restart();
  assert.equal(fs.readFileSync(f.passwordFile, 'utf8'), originalPassword);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), originalState);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.passwordFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
  }
  assert.notEqual(fixture(t).password, f.password);
});

test('default viewer includes localhost, forwarded hosts, query tokens, and empty requests', (t) => {
  const f = fixture(t);
  for (const req of [request(), request({ ip: '::1' }), request({ ip: '203.0.113.1' }), {}, undefined,
    request({ url: `/?token=${f.password}&password=${f.password}` }),
    { ...request(), headers: { host: 'localhost:8321', 'x-forwarded-for': '127.0.0.1' } }]) {
    assert.deepEqual(f.auth.session(req), VIEWER);
    assert.equal(f.auth.isAdmin(req), false);
    assert.equal(f.auth.sessionKey(req), undefined);
  }
  const defaults = new AdminAuth(f.home);
  assert.equal(defaults.trustedPost(request()), false);
  assert.equal(defaults.login(request(), f.password).status, 403);
});

test('existing corrupt, incomplete, invalid or mismatched credentials fail closed without overwrites', async (t) => {
  const cases = [
    ['invalid JSON', (f) => fs.writeFileSync(f.stateFile, '{broken')],
    ['null state', (f) => fs.writeFileSync(f.stateFile, 'null')],
    ['missing schema', (f) => fs.writeFileSync(f.stateFile, '{}')],
    ['bad hash', (f) => fs.writeFileSync(f.stateFile, JSON.stringify({ version: 1, algorithm: 'sha256', passwordHash: '00' }))],
    ['extra state fields', (f) => fs.writeFileSync(f.stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.stateFile)), admin: true }))],
    ['unknown version', (f) => fs.writeFileSync(f.stateFile, JSON.stringify({ version: 2, algorithm: 'sha256', passwordHash: sha(f.password) }))],
    ['wrong algorithm', (f) => fs.writeFileSync(f.stateFile, JSON.stringify({ version: 1, algorithm: 'md5', passwordHash: sha(f.password) }))],
    ['oversized state', (f) => fs.writeFileSync(f.stateFile, ' '.repeat(4097))],
    ['missing password', (f) => fs.unlinkSync(f.passwordFile)],
    ['missing state', (f) => fs.unlinkSync(f.stateFile)],
    ['empty password', (f) => fs.writeFileSync(f.passwordFile, '')],
    ['weak password', (f) => fs.writeFileSync(f.passwordFile, 'password\n')],
    ['mismatched password', (f) => fs.writeFileSync(f.passwordFile, randomBytes(32).toString('base64url'))],
  ];
  for (const [name, corrupt] of cases) await t.test(name, (t) => {
    const f = fixture(t);
    corrupt(f);
    const snapshot = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    const before = [snapshot(f.passwordFile), snapshot(f.stateFile)];
    assert.throws(f.restart, { message: 'Admin auth credentials unavailable' });
    assert.deepEqual([snapshot(f.passwordFile), snapshot(f.stateFile)], before);
  });
});

test('settings must contain exact canonical HTTPS or localhost/127.0.0.1 HTTP origins', (t) => {
  const home = homeFixture(t);
  for (const allowedOrigins of [null, 'https://room.example', ['http://room.example'], ['http://localhost:99999'],
    ['http://[::1]:8321'], ['null'], ['*'], ['https://room.example/'], ['https://room.example:443'],
    ['https://user:pass@room.example'], ['https://room.example/path'], ['HTTPS://room.example'], [null]]) {
    assert.throws(() => new AdminAuth(home, { allowedOrigins }), { message: 'Invalid admin auth settings' });
  }
  for (const sessionTtlMs of [0, -1, 0.5, NaN, Infinity, '1000']) {
    assert.throws(() => new AdminAuth(home, { sessionTtlMs }), { message: 'Invalid admin auth settings' });
  }
  assert.equal(fs.existsSync(path.join(home, 'data')), false);
});

test('explicit port-0 fixture origins work only with matching Host and loopback transport', (t) => {
  const origins = ['http://localhost:0', 'http://127.0.0.1:0'];
  const f = fixture(t, { allowedOrigins: origins });
  for (const origin of origins) {
    const req = request({ origin, host: new URL(origin).host });
    assert.equal(f.auth.trustedPost(req), true);
    const { cookie } = login(f, req);
    assert.equal(f.auth.isAdmin({ ...req, headers: { ...req.headers, cookie } }), true);
    assert.equal(f.auth.trustedPost(request({ origin, host: 'evil.example' })), false);
    assert.equal(f.auth.trustedPost(request({ origin, host: new URL(origin).host, ip: '203.0.113.9' })), false);
  }
  origins.push(LOCAL); // Mutating the caller's settings cannot expand an instance's trust.
  assert.equal(f.auth.trustedPost(request()), false);
});

test('local ports 8322 and 9000 require explicit allowlisting, matching Host, and loopback transport', (t) => {
  const defaults = fixture(t);
  for (const hostname of ['localhost', '127.0.0.1']) {
    for (const port of [8322, 9000]) {
      const host = `${hostname}:${port}`, origin = `http://${host}`;
      const req = request({ origin, host });
      assert.equal(defaults.auth.trustedPost(req), false);
      assert.equal(defaults.auth.login(req, defaults.password).status, 403);
      const f = fixture(t, { allowedOrigins: [origin] });
      const { cookie } = login(f, req);
      assert.equal(f.auth.isAdmin(request({ origin, host, cookie })), true);
      assert.equal(f.auth.trustedPost(request({ origin, host: 'evil.example' })), false);
      assert.equal(f.auth.trustedPost(request({ origin, host, ip: '203.0.113.9' })), false);
      assert.equal(f.auth.isAdmin(request({ origin, host, cookie, ip: '203.0.113.9' })), false);
      const unlistedHost = `${hostname}:${port === 8322 ? 9000 : 8322}`;
      assert.equal(f.auth.trustedPost(request({ origin: `http://${unlistedHost}`, host: unlistedHost })), false);
    }
  }
});

test('viewer requests skip credential filesystem checks while live admin sessions still check them', (t) => {
  clock(t);
  const f = fixture(t, { sessionTtlMs: 1000 }), { cookie } = login(f);
  const read = t.mock.method(fs, 'readFileSync');
  const stat = t.mock.method(fs, 'lstatSync');
  syncBuiltinESMExports();
  try {
    for (const req of [request(), request({ cookie: 'theme=dark' }), request({ cookie: 'broken' }),
      request({ cookie: `ai_chatroom_admin=${randomBytes(32).toString('base64url')}` }),
      request({ cookie: `${cookie}; ${cookie}` }), request({ cookie, ip: '203.0.113.9' })]) {
      assert.deepEqual(f.auth.session(req), VIEWER);
      assert.equal(f.auth.isAdmin(req), false);
      assert.equal(f.auth.sessionKey(req), undefined);
    }
    assert.equal(read.mock.callCount(), 0);
    assert.equal(stat.mock.callCount(), 0);
    assert.deepEqual(f.auth.session(request({ cookie })), ADMIN);
    assert.equal(read.mock.callCount(), 2);
    assert.equal(stat.mock.callCount(), 3);
    t.mock.timers.tick(1000);
    assert.deepEqual(f.auth.session(request({ cookie })), VIEWER);
    assert.equal(read.mock.callCount(), 2);
    assert.equal(stat.mock.callCount(), 3);
  } finally {
    read.mock.restore();
    stat.mock.restore();
    syncBuiltinESMExports();
  }
});

test('trusted JSON mutations accept only explicitly listed origins and a trustworthy transport', (t) => {
  const f = fixture(t);
  for (const ip of ['127.0.0.1', '127.2.3.4', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(f.auth.trustedPost(request({ ip })), true, ip);
  }
  assert.equal(f.auth.trustedPost(request({ origin: IP_LOCAL, host: '127.0.0.1:8321' })), true);
  assert.equal(f.auth.trustedPost(request({ origin: HTTPS, ip: '203.0.113.9', encrypted: true })), true);
  assert.equal(f.auth.trustedPost(request({ origin: HTTPS })), true); // Explicit trusted loopback proxy.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(f.auth.trustedPost(request({ method, type: 'application/json; charset=UTF-8' })), true);
  }
  const denied = [
    request({ origin: 'null' }), request({ origin: 'https://evil.example' }),
    request({ origin: LOCAL + '/' }), request({ origin: 'http://room.example' }),
    request({ host: 'evil.example' }), request({ host: '127.0.0.1:8321' }),
    request({ ip: '203.0.113.9' }), request({ ip: '203.0.113.9', encrypted: true }),
    request({ origin: HTTPS, ip: '203.0.113.9' }), request({ origin: HTTPS, ip: '::ffff:203.0.113.9' }),
    request({ type: 'text/plain' }), request({ type: 'application/jsonp' }),
    request({ type: 'application/json, text/plain' }), request({ method: 'GET' }),
    request({ origin: [LOCAL] }), request({ type: ['application/json'] }),
    request({ origin: `${LOCAL}\r\nX: y` }), request({ ip: 'not-an-ip' }), request({ ip: 'fe80::1%5' }), {}, undefined,
    request({ rawHeaders: ['Origin', LOCAL, 'Origin', LOCAL] }),
    request({ rawHeaders: ['Content-Type', 'application/json', 'content-type', 'text/plain'] }),
    request({ rawHeaders: ['Host', 'localhost:8321', 'Host', 'evil.example'] }),
  ];
  const absentOrigin = request(); delete absentOrigin.headers.origin; denied.push(absentOrigin);
  const absentType = request(); delete absentType.headers['content-type']; denied.push(absentType);
  const absentHost = request(); delete absentHost.headers.host; denied.push(absentHost);
  const spoofed = request({ origin: HTTPS, ip: '203.0.113.9' });
  Object.assign(spoofed.headers, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1',
    'x-forwarded-host': 'localhost:8321', forwarded: 'for=127.0.0.1;proto=https;host=localhost:8321' });
  denied.push(spoofed);
  for (const req of denied) {
    assert.equal(f.auth.trustedPost(req), false);
    assert.deepEqual(f.auth.login(req, f.password), { ok: false, status: 403, error: 'Untrusted request' });
  }
});

test('successful login returns the exact API shape, a separate token, and hardened session cookie', (t) => {
  const f = fixture(t), { result, cookie } = login(f);
  assert.deepEqual(Object.keys(result).sort(), ['cookie', 'ok', 'session', 'status']);
  assert.equal(result.status, 200);
  assert.deepEqual(result.session, ADMIN);
  assert.match(result.cookie, /^ai_chatroom_admin=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
  assert.equal(result.cookie.includes(f.password), false);
  assert.equal(result.cookie.includes('Domain='), false);
  const req = request({ cookie, method: 'GET' });
  delete req.headers.origin;
  assert.deepEqual(f.auth.session(req), ADMIN);
  assert.equal(f.auth.isAdmin(req), true);
  assert.equal(f.auth.sessionKey(req), sha(cookie.split('=')[1]));
  assert.equal(f.auth.sessionKey(request({ cookie: `theme=dark; ${cookie}` })), f.auth.sessionKey(req));
  assert.equal(f.auth.isAdmin(request({ cookie, ip: '203.0.113.9' })), false);
  assert.equal(f.auth.isAdmin(request({ cookie, host: 'evil.example' })), false);
  assert.equal(f.auth.isAdmin(request({ url: `/?token=${cookie.split('=')[1]}` })), false);
  assert.deepEqual(f.restart().session(req), VIEWER);
});

test('TLS and explicitly trusted HTTPS proxy logins use Secure cookies; external HTTP cannot replay them', (t) => {
  const f = fixture(t);
  for (const req of [request({ origin: HTTPS }), request({ origin: HTTPS, ip: '203.0.113.8', encrypted: true }),
    request({ encrypted: true })]) {
    const { result, cookie } = login(f, req);
    assert.match(result.cookie, /; Secure$/);
    const authenticated = { ...req, headers: { ...req.headers, cookie } };
    assert.equal(f.auth.isAdmin(authenticated), true);
    assert.equal(f.auth.isAdmin(request({ cookie, origin: HTTPS, ip: '203.0.113.8' })), false);
    assert.match(f.auth.logout(authenticated), /; Secure$/);
    assert.equal(f.auth.isAdmin(authenticated), false);
  }
});

test('duplicate, malformed, truncated, encoded and forged cookies fail closed', (t) => {
  const f = fixture(t), { cookie } = login(f);
  const token = cookie.split('=')[1];
  for (const value of [`${cookie}; ${cookie}`, `x=1; x=2; ${cookie}`, `${cookie}; broken`, `${cookie};`,
    `ai_chatroom_admin=${token.slice(1)}`, `ai_chatroom_admin=%41${token.slice(1)}`, `ai_chatroom_admin="${token}"`,
    `ai_chatroom_admin=${f.password}`, `ai_chatroom_admin=${randomBytes(32).toString('base64url')}`,
    `ai_chatroom_admin=`, `${cookie}, x=y`, `${cookie}\r\nx=y`, ['a=b', cookie], 'a'.repeat(8193)]) {
    const req = request({ cookie: value });
    assert.deepEqual(f.auth.session(req), VIEWER);
    assert.equal(f.auth.sessionKey(req), undefined);
  }
  const duplicate = request({ cookie, rawHeaders: ['Cookie', cookie, 'cookie', 'other=value'] });
  assert.equal(f.auth.isAdmin(duplicate), false);
  assert.equal(f.auth.login(duplicate, f.password).status, 400);
  assert.equal(f.auth.isAdmin(request({ cookie })), true);
});

test('logout immediately revokes session and returns a clearing cookie; relogin rotates old tokens', (t) => {
  const f = fixture(t), first = login(f);
  const firstReq = request({ cookie: first.cookie });
  const second = login(f, firstReq);
  assert.notEqual(first.cookie, second.cookie);
  assert.equal(f.auth.isAdmin(firstReq), false);
  const req = request({ cookie: second.cookie });
  assert.equal(f.auth.isAdmin(req), true);
  assert.equal(f.auth.logout(req), 'ai_chatroom_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  assert.deepEqual(f.auth.session(req), VIEWER);
  assert.equal(f.auth.sessionKey(req), undefined);
  assert.match(f.auth.logout(request()), /Max-Age=0/);
});

test('mounted login ignores duplicate legacy credentials, including invalid tokens with valid cookie syntax', (t) => {
  const f = fixture(t, { cookiePath: '/chat/' });
  const { cookie } = login(f);
  const token = cookie.split('=')[1];
  const legacyHeaders = [
    `ai_chatroom_admin=${token}; ai_chatroom_admin=${randomBytes(32).toString('base64url')}`,
    'ai_chatroom_admin=; ai_chatroom_admin=not-a-token',
    `ai_chatroom_admin=%41${token.slice(1)}; ai_chatroom_admin=${token.slice(1)}`,
  ];
  for (const legacy of legacyHeaders) {
    const req = request({ cookie: legacy });
    assert.deepEqual(f.auth.session(req), VIEWER);
    assert.equal(f.auth.sessionKey(req), undefined);
    assert.equal(f.auth.login(req, 'wrong').status, 401);
    const current = login(f, req);
    assert.match(current.cookie, /^ai_chatroom_admin_bb54ad1461c6a5aa=[\w-]{43}$/);
    for (const combined of [`${legacy}; ${current.cookie}`, `${current.cookie}; ${legacy}`]) {
      assert.deepEqual(f.auth.session(request({ cookie: combined })), ADMIN);
    }
  }
  assert.equal(f.auth.isAdmin(request({ cookie })), true);
});

test('mounted cookies retain strict syntax, current-name duplicate checks, and login failure accounting', (t) => {
  const f = fixture(t, { cookiePath: '/chat/' }), { cookie } = login(f);
  const [name, token] = cookie.split('=');
  const legacy = 'ai_chatroom_admin=old; ai_chatroom_admin=older';
  const denied = [
    `${cookie}; ${cookie}`, `${cookie}; ${name}=${randomBytes(32).toString('base64url')}`,
    `${legacy}; ${cookie}; ${cookie}`, `${legacy}; x=1; x=2; ${cookie}`,
    `${cookie}; ai_chatroom_admin_extra=1; ai_chatroom_admin_extra=2`,
    `${cookie}; ai_chatroom_admin="old"`, `${cookie}; ai_chatroom_admin=bad value`,
    `${cookie}; ai_chatroom_admin=old,other=value`, `${cookie}; ai_chatroom_admin`,
    `${cookie}; bad name=value`, `${cookie};`, `${cookie}\r\nx=y`,
    `${name}=`, `${name}=${token.slice(1)}`, `${name}=%41${token.slice(1)}`,
    `${name}="${token}"`, 'ai_chatroom_admin=' + 'a'.repeat(8192),
    ['ai_chatroom_admin=old', cookie], '',
  ].map(cookie => request({ cookie }));
  denied.push(request({ cookie: `${legacy}; ${cookie}`, rawHeaders: ['Cookie', legacy, 'cookie', cookie] }));
  for (const req of denied) {
    assert.deepEqual(f.auth.session(req), VIEWER);
    assert.equal(f.auth.sessionKey(req), undefined);
    assert.equal(f.auth.login(req, 'wrong').status, 400);
  }
  for (const forged of [f.password, randomBytes(32).toString('base64url')]) {
    assert.deepEqual(f.auth.session(request({ cookie: `${legacy}; ${name}=${forged}` })), VIEWER);
  }
  assert.equal(f.auth.isAdmin(request({ cookie })), true);
  login(f, request({ cookie: legacy })); // Invalid cookies above did not consume the failure budget.
  for (let i = 0; i < 5; i++) assert.equal(f.auth.login(request({ cookie: legacy }), 'wrong').status, 401);
  assert.equal(f.auth.login(request({ cookie: legacy }), f.password).status, 429);
});

test('cookie names isolate root, sibling and nested mounts and stay stable without changing credentials', (t) => {
  const f = fixture(t);
  const before = [f.passwordFile, f.stateFile].map(file => fs.readFileSync(file, 'utf8'));
  const scopes = ['/', '/chat/', '/chat/admin/', '/other/'].map(cookiePath => {
    const auth = new AdminAuth(f.home, { ...f.settings, cookiePath });
    const { cookie } = login({ auth, password: f.password });
    const name = cookie.split('=')[0];
    assert.equal(name, cookiePath === '/' ? 'ai_chatroom_admin' : `ai_chatroom_admin_${sha(cookiePath).slice(0, 16)}`);
    const restarted = new AdminAuth(f.home, { ...f.settings, cookiePath });
    assert.equal(login({ auth: restarted, password: f.password }).cookie.split('=')[0], name);
    assert.deepEqual(restarted.session(request({ cookie })), VIEWER);
    return { auth, cookie, name };
  });
  assert.equal(new Set(scopes.map(scope => scope.name)).size, scopes.length);
  const combined = scopes.map(scope => scope.cookie).join('; ');
  for (const current of scopes) {
    assert.deepEqual(current.auth.session(request({ cookie: combined })), ADMIN);
    for (const other of scopes.filter(scope => scope !== current)) {
      assert.deepEqual(current.auth.session(request({ cookie: other.cookie })), VIEWER);
      // Even this instance's valid token under another scope's name is not a credential.
      assert.deepEqual(current.auth.session(request({ cookie: `${other.name}=${current.cookie.split('=')[1]}` })), VIEWER);
    }
  }
  assert.deepEqual([f.passwordFile, f.stateFile].map(file => fs.readFileSync(file, 'utf8')), before);
});

test('mounted rotation and logout select only the scoped token and preserve cookie security attributes', (t) => {
  const f = fixture(t, { cookiePath: '/chat/' });
  const root = new AdminAuth(f.home, { ...f.settings, cookiePath: '/' });
  const rootCookie = login({ auth: root, password: f.password }).cookie;
  for (const options of [{}, { origin: HTTPS }, { origin: HTTPS, ip: '203.0.113.8', encrypted: true }, { encrypted: true }]) {
    const secure = options.origin === HTTPS || options.encrypted === true;
    const legacy = `${rootCookie}; ai_chatroom_admin=old-mounted-token`;
    const first = login(f, request({ ...options, cookie: legacy }));
    const [name, token] = first.cookie.split('=');
    assert.equal(first.result.cookie, `${first.cookie}; HttpOnly; SameSite=Strict; Path=/chat/; Max-Age=43200${secure ? '; Secure' : ''}`);
    f.auth.logout(request({ ...options, cookie: `ai_chatroom_admin=${token}` }));
    const firstReq = request({ ...options, cookie: `${legacy}; ${first.cookie}` });
    assert.equal(f.auth.isAdmin(firstReq), true, 'a legacy name cannot revoke a scoped session');
    const second = login(f, firstReq);
    assert.equal(f.auth.isAdmin(firstReq), false);
    const secondReq = request({ ...options, cookie: `${second.cookie}; ${legacy}` });
    assert.equal(f.auth.isAdmin(secondReq), true);
    assert.equal(f.auth.logout(secondReq), `${name}=; HttpOnly; SameSite=Strict; Path=/chat/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`);
    assert.deepEqual(f.auth.session(secondReq), VIEWER);
    assert.equal(root.isAdmin(request({ cookie: rootCookie })), true);
  }
});

test('default and explicit root scopes retain the legacy name and reject duplicate or malformed credentials', (t) => {
  for (const options of [{}, { cookiePath: '/' }]) {
    const f = fixture(t, options), { result, cookie } = login(f);
    assert.match(result.cookie, /^ai_chatroom_admin=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
    for (const invalid of [`${cookie}; ${cookie}`, 'ai_chatroom_admin=old', 'ai_chatroom_admin=']) {
      const req = request({ cookie: invalid });
      assert.deepEqual(f.auth.session(req), VIEWER);
      assert.equal(f.auth.login(req, f.password).status, 400);
    }
    assert.equal(f.auth.isAdmin(request({ cookie })), true);
    assert.equal(f.auth.logout(request({ cookie })), 'ai_chatroom_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
});

test('expiry is enforced exactly at TTL, including recheck after awaiting a request body', async (t) => {
  clock(t);
  const f = fixture(t, { sessionTtlMs: 1500 }), { cookie, result } = login(f);
  assert.match(result.cookie, /Max-Age=2/);
  const req = request({ cookie });
  assert.equal(f.auth.trustedPost(req), true);
  assert.equal(f.auth.isAdmin(req), true);
  t.mock.timers.tick(1499);
  assert.equal(f.auth.isAdmin(req), true);
  await Promise.resolve();
  t.mock.timers.tick(1);
  assert.deepEqual(f.auth.session(req), VIEWER);
  assert.equal(f.auth.sessionKey(req), undefined);
});

test('wrong passwords, nonstrings, excessive inputs and byte limits never leak credentials', (t) => {
  const f = fixture(t);
  for (const [password, status] of [['wrong', 401], [null, 400], ['x'.repeat(513), 400], ['가'.repeat(200), 400]]) {
    const result = f.auth.login(request(), password);
    assert.deepEqual(Object.keys(result).sort(), ['error', 'ok', 'status']);
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(JSON.stringify(result).includes(f.password), false);
    assert.deepEqual(f.auth.session(request()), VIEWER);
  }
  assert.equal(f.auth.login(request(), f.password).ok, true);
});

test('per-IP rolling failure limit ignores forwarding headers, includes invalid input, and survives success', (t) => {
  clock(t);
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    const req = request({ ip: i % 2 ? '::ffff:127.0.0.1' : '127.0.0.1' });
    req.headers['x-forwarded-for'] = `203.0.113.${i}`;
    assert.equal(f.auth.login(req, 'wrong').status, 401);
  }
  login(f);
  assert.equal(f.auth.login(request(), 'x'.repeat(513)).status, 400);
  assert.equal(f.auth.login(request(), f.password).status, 429);
  t.mock.timers.tick(15 * 60 * 1000 - 1);
  assert.equal(f.auth.login(request(), f.password).status, 429);
  t.mock.timers.tick(1);
  assert.equal(f.auth.login(request(), f.password).ok, true);
});

test('failure windows roll per attempt rather than resetting as a fixed window', (t) => {
  clock(t);
  const f = fixture(t);
  assert.equal(f.auth.login(request(), 'wrong').status, 401);
  t.mock.timers.tick(60 * 1000);
  for (let i = 0; i < 4; i++) assert.equal(f.auth.login(request(), 'wrong').status, 401);
  assert.equal(f.auth.login(request(), f.password).status, 429);
  t.mock.timers.tick(14 * 60 * 1000);
  assert.equal(f.auth.login(request(), 'wrong').status, 401);
  assert.equal(f.auth.login(request(), f.password).status, 429);
  t.mock.timers.tick(60 * 1000);
  assert.equal(f.auth.login(request(), f.password).ok, true);
});

test('global rolling limit caps failures from many IPs at 30 per hour and bounds rate state', (t) => {
  clock(t);
  const f = fixture(t);
  for (let i = 1; i <= 30; i++) {
    assert.equal(f.auth.login(request({ origin: HTTPS, encrypted: true, ip: `203.0.113.${i}` }), 'wrong').status, 401);
  }
  const next = request({ origin: HTTPS, encrypted: true, ip: '203.0.113.31' });
  for (let i = 31; i < 80; i++) {
    assert.equal(f.auth.login(request({ origin: HTTPS, encrypted: true, ip: `203.0.113.${i}` }), 'wrong').status, 429);
  }
  t.mock.timers.tick(60 * 60 * 1000 - 1);
  assert.equal(f.auth.login(next, f.password).status, 429);
  t.mock.timers.tick(1);
  assert.equal(f.auth.login(next, f.password).ok, true);
});

test('credential changes, corruption, and removal revoke live sessions without regenerating secrets', async (t) => {
  for (const kind of ['remove-password', 'remove-state', 'corrupt', 'rotate']) await t.test(kind, (t) => {
    const f = fixture(t), { cookie } = login(f), req = request({ cookie });
    const originalState = fs.readFileSync(f.stateFile, 'utf8');
    if (kind === 'remove-password') fs.unlinkSync(f.passwordFile);
    if (kind === 'remove-state') fs.unlinkSync(f.stateFile);
    if (kind === 'corrupt') fs.writeFileSync(f.stateFile, '{}');
    if (kind === 'rotate') {
      const replacement = randomBytes(32).toString('base64url');
      fs.writeFileSync(f.passwordFile, `${replacement}\n`);
      fs.writeFileSync(f.stateFile, JSON.stringify({ version: 1, algorithm: 'sha256', passwordHash: sha(replacement) }));
      assert.equal(f.restart().login(request(), replacement).ok, true);
    }
    assert.deepEqual(f.auth.session(req), VIEWER);
    assert.equal(f.auth.login(request(), f.password).status, 503);
    if (kind === 'remove-password') assert.equal(fs.existsSync(f.passwordFile), false);
    if (kind === 'remove-state') assert.equal(fs.existsSync(f.stateFile), false);
    // Restoring old files must not resurrect the revoked in-memory token.
    fs.writeFileSync(f.passwordFile, `${f.password}\n`);
    fs.writeFileSync(f.stateFile, originalState);
    assert.equal(f.auth.isAdmin(req), false);
    assert.equal(f.auth.login(request(), f.password).status, 503);
  });
});

test('session memory is bounded and evicts the oldest token', (t) => {
  const f = fixture(t), first = login(f);
  let last;
  for (let i = 0; i < 256; i++) last = login(f);
  assert.equal(f.auth.isAdmin(request({ cookie: first.cookie })), false);
  assert.equal(f.auth.isAdmin(request({ cookie: last.cookie })), true);
});
