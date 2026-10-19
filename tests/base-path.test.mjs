// Synthetic loopback fixtures only: no production server, runtime data or calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import { appUrl, getBasePath } from '../public/base-path.js';
import { setPersonaMembers, avatarSpec, avatarMarkup } from '../public/persona-client.js';
import { buildHouse } from '../lib/house.mjs';

const root = path.resolve(import.meta.dirname, '../public');
const documentFor = (content) => ({ querySelector: () => content === null ? null : { getAttribute: () => content } });
function withBase(content, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentFor(content) });
  try { return fn(); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete globalThis.document;
  }
}

test('base path is explicitly injected, validated and independent of page location', () => {
  for (const [content, expected] of [[null, ''], ['', ''], ['/', ''], ['/chat', '/chat'], ['/chat/', '/chat'], ['/site/chat-room_2', '/site/chat-room_2']]) {
    withBase(content, () => {
      assert.equal(getBasePath(), expected);
      for (const route of ['/', '/api/state', '/events', '/admin', '/topics', '/api/file?path=images%2Fa%20b.png', '/ws/images/a%20b.png?t=123#preview']) {
        assert.equal(appUrl(route), expected + route);
        assert.equal(new URL(appUrl(route), 'https://example.invalid/other/page').origin, 'https://example.invalid');
      }
    });
  }
  for (const base of ['chat', '//host', 'https://host/chat', '/chat//room', '/chat/..', '/chat/./room', '/chat%2fadmin', '/chat?x=1', '/chat#x', '/chat\\admin', '/chat\n', '/chat" onload="x']) {
    withBase(base, () => assert.throws(() => appUrl('/api/state'), TypeError, base));
  }
  withBase('/chat', () => {
    for (const route of ['api/state', '//host/path', 'https://host/path', '/\\host/path', '/a/../api', '/%2e%2e/api', '/a/%2F/api', '/a/%5c/api', '/api\n/state', '/api state', null]) {
      assert.throws(() => appUrl(route), TypeError, String(route));
    }
  });
});

test('portrait mount prefix preserves public-route allowlist and avatar crops', () => {
  withBase('/chat', () => {
    try {
      const crop = { x: 0, y: 0.1, width: 0.5, height: 0.5 };
      setPersonaMembers([{ id: 'eleven', persona: { skin: { avatar: '/assets/characters/eleven/avatar.png', avatarCrop: crop } } }]);
      assert.deepEqual(avatarSpec('eleven'), { src: '/chat/assets/characters/eleven/avatar.png', crop });
      assert.match(avatarMarkup('eleven'), /data-shared-src="\/chat\/assets\/characters\/eleven\/avatar.png\?preview=1"/);
      assert.equal(avatarSpec('dev').src, '/chat/assets/characters/dev/full.png');
      for (const src of ['/avatars/private.svg', '/chat/assets/characters/eleven/avatar.png', '//elsewhere/avatar.png', '/assets/characters/adina/avatar.png']) {
        setPersonaMembers([{ id: 'eleven', persona: { skin: { avatar: src } } }]);
        assert.equal(avatarSpec('eleven').src, '');
      }
    } finally { setPersonaMembers([]); }
  });
});

// This is the parent serveHtml contract, not an alternate client router.
function serveHtml(source, base) {
  return source.replace('<head>', `<head><meta name="chatroom-base" content="${base}">`)
    .replace(/\b(href|src|action)=(['"])\/(?!\/)/g, `$1=$2${base}/`);
}
test('static navigation/form assets mount with HTML rewriting and imports remain relative', () => {
  for (const base of ['', '/chat']) {
    for (const file of ['index.html', 'world.html', 'licenses.html']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const html = serveHtml(source, base);
      assert.ok(html.includes(`name="chatroom-base" content="${base}"`));
      for (const match of html.matchAll(/\b(?:href|src|action)=["'](\/[^"']*)/g)) {
        assert.ok(match[1].startsWith(base + '/'), `${file}: ${match[1]}`);
      }
      assert.doesNotMatch(source, /\bfrom\s+['"]\//, file);
    }
    assert.match(serveHtml(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), base), new RegExp(`href="${base}/topics">이야기 제보`));
  }
  for (const file of ['app.js', 'persona-client.js', 'presentation.js', 'base-path.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /\bfrom\s+['"]\//, file);
  }
});

const require = createRequire(import.meta.url);
let chromium;
for (const module of [process.env.CHATROOM_PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { ({ chromium } = require(module)); break; } catch { /* next installed runtime */ }
}
const executablePath = process.env.CHATROOM_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const browserOptions = { timeout: 30000, skip: !chromium && 'Set CHATROOM_PLAYWRIGHT_MODULE for browser checks' };
const threeRoot = process.env.CHATROOM_THREE_ROOT;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const message = (id) => ({ id, ts: 1700000000000 + id * 1000, from: 'eleven', text: `합성 대화 ${id}` });
async function until(predicate) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'fixture condition timed out');
}

async function fixture(t, base, { pathname = '/', world = false, messages = [1, 2, 3, 4].map(message) } = {}) {
  const requests = [], clients = new Set(), errors = [], escaped = [];
  const ids = ['eleven', 'adina', 'lucia', 'bianca'];
  const members = ids.map((id) => ({ id, name: id, status: 'idle', enabled: true, available: true, color: '#337755',
    persona: { skin: { avatar: `/assets/characters/${id}/avatar.png` } } }));
  const data = {
    room: { running: true, sleeping: false, userName: 'ERCraft', dev: { online: false } }, members,
    messages,
    files: [{ path: 'shared.txt', size: 12, mtime: 1 }, { path: 'images/photo.png', size: pixel.length, mtime: 2 }],
    sleeps: Object.fromEntries(ids.map((id) => [id, { state: 'awake', level: 0, remainingPct: 87.65 }])),
  };
  const settings = { speed: 'slow', autoSleepMin: 60, boostMode: 'manual' };
  let active = false, holdHistory = false, releaseHistory, failHistory = false, holdState = false, releaseState;
  const session = (req) => ({ role: active && req.headers.cookie?.includes('fixture=admin') ? 'admin' : 'viewer', authenticated: !!(active && req.headers.cookie?.includes('fixture=admin')) });
  const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, search: url.search, cookie: req.headers.cookie, method: req.method });
    if (base && !url.pathname.startsWith(base + '/')) { escaped.push(url.pathname); res.writeHead(404); res.end(); return; }
    const route = url.pathname.slice(base.length);
    if (route === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(`retry: 30\nevent: session\ndata: ${JSON.stringify(session(req))}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (route === '/api/state') {
      const snapshot = structuredClone({ ...data, messages: data.messages.slice(-80), session: session(req), batteries: { eleven: { level: 0, state: 'ready' } }, usage: { secret: 87.65 } });
      if (holdState) { holdState = false; releaseState = () => { json(res, snapshot); releaseState = null; }; }
      else json(res, snapshot);
      return;
    }
    if (route === '/api/history') {
      const before = Number(url.searchParams.get('before'));
      if (failHistory) { failHistory = false; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"synthetic history failure"}'); return; }
      const limit = Number(url.searchParams.get('limit')) || 60;
      const messages = data.messages.filter((m) => m.id < before).slice(-Math.min(200, limit));
      if (holdHistory) { holdHistory = false; releaseHistory = () => { json(res, { messages }); releaseHistory = null; }; }
      else json(res, { messages });
      return;
    }
    if (route === '/api/admin/settings') return json(res, settings);
    if (route === '/api/file') return json(res, { text: '합성 파일' });
    if (route === '/api/notes') return json(res, { eleven: '합성 메모' });
    if (route === '/api/world') return json(res, { size: { x: 48, y: 16, z: 48 }, home: buildHouse().home,
      palette: { planks: ['p', '#c8a063'] }, blocks: [[12, 1, 12, 'planks']], signs: {}, custom: {},
      avatars: Object.fromEntries(ids.map((id, i) => [id, { x: 12 + i, y: 1, z: 18 }])) });
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      if (route === '/api/admin/login') {
        active = JSON.parse(body).password === 'fixture-secret';
        res.setHeader('Set-Cookie', `fixture=admin; HttpOnly; SameSite=Strict; Path=${base}/`);
      }
      if (route === '/api/admin/logout') { active = false; res.setHeader('Set-Cookie', `fixture=; Max-Age=0; Path=${base}/`); }
      if (route === '/api/room') Object.assign(settings, JSON.parse(body));
      return json(res, route === '/api/room' ? { ...data.room, ...settings } : session(req));
    }
    if (route.startsWith('/assets/characters/') || route.startsWith('/ws/') && route.endsWith('.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(pixel); return;
    }
    if (route === '/ws/demo.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': 'sandbox allow-scripts' }); res.end('<p>synthetic frame</p>'); return; }
    const relative = ['/', '/admin'].includes(route) ? 'index.html' : route === '/licenses' ? 'licenses.html' : route.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file), source = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[ext] || 'application/octet-stream' });
    res.end(ext === '.html' ? serveHtml(source.toString(), base) : source);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const client of clients) client.end(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath, args: world ? ['--enable-unsafe-swiftshader'] : [] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    const prefix = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';
    if (world && threeRoot && route.request().url().startsWith(prefix)) {
      const file = path.resolve(threeRoot, route.request().url().slice(prefix.length));
      if (file.startsWith(path.resolve(threeRoot) + path.sep) && fs.existsSync(file)) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(file) });
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + base + pathname);
  await page.waitForSelector(world ? '#who button' : '#members .member');
  await until(() => clients.size > 0);
  return { page, context, requests, errors, escaped, data, origin,
    emit: (event, value) => { for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); },
    disconnect: () => { for (const client of clients) client.end(); clients.clear(); },
    holdHistory: () => { holdHistory = true; },
    historyHeld: () => !!releaseHistory,
    releaseHistory: () => releaseHistory?.(),
    failHistory: () => { failHistory = true; },
    holdState: () => { holdState = true; },
    stateHeld: () => !!releaseState,
    releaseState: () => releaseState?.(),
    expire: () => { active = false; },
  };
}

test('delayed photos preserve the visible anchor, release detached nodes, and live-bottom DOM stays capped', browserOptions, async t => {
  const f = await fixture(t, '/chat', { messages: Array.from({ length: 1000 }, (_, i) => message(i + 1)) }), p = f.page;
  let releasePhoto;
  await p.route('**/ws/images/late.png*', route => new Promise(resolve => {
    releasePhoto = async () => { await route.fulfill({ contentType: 'image/png', body: pixel }); resolve(); };
  }));
  f.emit('msg', { ...message(1001), attach: { path: 'images/late.png' } });
  f.emit('msg', message(1002));
  await until(() => !!releasePhoto);
  await p.waitForSelector('#m1002');
  for (let id = 1003; id <= 1030; id++) f.emit('msg', message(id));
  await p.waitForSelector('#m1030');
  await p.locator('#m1002').evaluate(node => { node.scrollIntoView({ block: 'start' }); document.querySelector('#timeline').scrollTop -= 100; });
  await p.waitForTimeout(60);
  const before = await p.locator('#m1002').evaluate(node => node.getBoundingClientRect().top);
  await releasePhoto();
  await p.waitForFunction(() => document.querySelector('#m1001 img.att-img')?.dataset.sharedState === 'ready');
  await p.waitForTimeout(60);
  const after = await p.locator('#m1002').evaluate(node => node.getBoundingClientRect().top);
  assert.ok(Math.abs(after - before) < 2, JSON.stringify({ before, after }));
  await p.evaluate(async () => {
    const { TimelineWindow } = await import('/chat/timeline-window.js');
    const original = TimelineWindow.prototype.setItems;
    TimelineWindow.prototype.setItems = function (...args) { original.apply(this, args); window.timelineProbe = { items: this.items.length, heights: this.heights.size, mounted: this.nodes.size }; };
    window.detachedPhoto = document.querySelector('#m1001 img.att-img'); window.maxTimelineRows = 0;
    new MutationObserver(() => { window.maxTimelineRows = Math.max(window.maxTimelineRows, document.querySelectorAll('#msgs .timeline-item').length); })
      .observe(document.querySelector('#msgs'), { childList: true }); });
  await p.locator('#jump').click();
  for (let id = 1031; id <= 2030; id++) f.emit('msg', { ...message(id), attach: { path: 'images/photo.png' } });
  await p.waitForSelector('#m2030');
  await p.waitForFunction(() => !window.detachedPhoto.isConnected && !window.detachedPhoto.hasAttribute('src'));
  assert.equal(await p.locator('#msgs .timeline-item').count(), 180);
  assert.equal(await p.locator('#msgs img.att-img').count(), 180);
  const retained = await p.evaluate(() => window.timelineProbe);
  assert.equal(retained.items, 600); assert.ok(retained.heights <= 600); assert.equal(retained.mounted, 180);
  t.diagnostic(JSON.stringify({ retained, imageAnchorDelta: after - before }));
  assert.ok(await p.evaluate(() => window.maxTimelineRows) <= 180);
  const distance = await p.locator('#timeline').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert.ok(distance < 2);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.escaped, []);
});

test('pending snapshot and history cannot restore an expired admin session', browserOptions, async t => {
  const f = await fixture(t, '/chat', { pathname: '/admin', messages: Array.from({ length: 1000 }, (_, i) => message(i + 1)) }), p = f.page;
  await p.locator('#adminPassword').fill('fixture-secret'); await p.locator('#loginSubmit').click();
  await p.waitForFunction(() => document.body.dataset.role === 'admin');
  f.holdHistory();
  await p.locator('#timeline').evaluate(node => { node.scrollTop = 0; }); await until(f.historyHeld);
  f.holdState(); f.disconnect(); await until(f.stateHeld);
  f.expire(); f.emit('session', { role: 'viewer', authenticated: false });
  await p.waitForFunction(() => document.body.dataset.role === 'viewer');
  await until(() => f.requests.filter(r => r.path === '/chat/api/state').length >= 4);
  f.releaseHistory(); f.releaseState();
  await p.waitForTimeout(100);
  assert.equal(await p.locator('#m861').count(), 0);
  assert.equal(await p.locator('#msgs .msg').count(), 80);
  assert.equal(await p.locator('.settings').isVisible(), false);
  assert.equal(await p.locator('#input').getAttribute('readonly'), '');
  assert.equal(await p.locator('#send').isDisabled(), true);
  assert.equal(await p.locator('#msgs .tools:not([hidden])').count(), 0);
  assert.doesNotMatch(await p.locator('#members').innerText(), /87\.65|%|배터리|충전/);
  assert.doesNotMatch(await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), /fixture-secret|87\.65|batter/);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.escaped, []);
});

test('a long in-flight reconnect retains newest80 of 1000 pending events without bridging a gap', browserOptions, async t => {
  const f = await fixture(t, '/chat'), p = f.page;
  f.data.messages = Array.from({ length: 610 }, (_, i) => message(i + 1));
  f.holdState(); f.disconnect(); await until(f.stateHeld);
  for (let id = 611; id <= 1610; id++) f.emit('msg', message(id));
  f.emit('msgupdate', { id: 1609, reactions: { '👍': ['user'] } });
  // A final room event acts as a stream barrier before releasing the old HTTP body.
  f.emit('room', { running: false, sleeping: true });
  await p.waitForSelector('#app.sleeping'); f.releaseState();
  await p.waitForSelector('#m1610', { state: 'attached' });
  assert.deepEqual(await p.locator('#msgs .msg').evaluateAll(nodes => nodes.map(node => +node.id.slice(1))), Array.from({ length: 80 }, (_, i) => 1531 + i));
  assert.equal(await p.locator('#m1609 .chip').textContent(), '👍 1');
  assert.equal(f.requests.filter(r => r.path === '/chat/api/history').length, 0);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.escaped, []);
});

for (const base of ['', '/chat']) {
  test(`client reads, assets, sleep SSE and scoped admin session at ${base || '/'}`, browserOptions, async (t) => {
    const f = await fixture(t, base, { pathname: '/admin' }), p = f.page;
    await p.waitForSelector('#loginDialog[open]');
    assert.equal(await p.locator('#loginForm').getAttribute('action'), base + '/api/admin/login');
    assert.equal(await p.getByRole('link', { name: '이야기 제보' }).getAttribute('href'), base + '/topics');
    assert.equal(await p.locator('.world-link').getAttribute('href'), base + '/world.html');
    await p.waitForFunction(() => [...document.querySelectorAll('#brandAvatars img')].length === 4
      && [...document.querySelectorAll('#brandAvatars img')].every((img) => img.complete && img.naturalWidth > 0));
    assert.equal(await p.locator('.sleep-awake').count(), 4);
    f.emit('batteries', { eleven: { state: 'ready', level: 0 } });
    f.emit('sleeps', { eleven: { state: 'asleep', level: 4, remainingPct: 87.65 }, adina: { state: 'resting' }, lucia: { state: 'drowsy', level: 0 }, bianca: { state: 'awake' } });
    await p.waitForSelector('.sleep-asleep');
    assert.equal(await p.locator('.sleep-unknown').count(), 1);
    assert.equal(await p.locator('.sleep-resting').count(), 1);
    assert.doesNotMatch(await p.locator('#members').innerText(), /87\.65|%|배터리|충전/);
    await p.locator('#loginClose').click();
    f.emit('msg', { ...message(5), attach: { path: 'images/photo.png' } });
    f.emit('msg', { ...message(6), attach: { path: 'demo.html' } });
    await p.waitForSelector('#m6 iframe');
    await p.waitForFunction(() => { const img = document.querySelector('#m5 img.att-img'); return img?.complete && img.naturalWidth > 0; });
    assert.equal(await p.locator('#m5 img.att-img').getAttribute('data-shared-src'), base + `/ws/images/photo.png?t=2-${pixel.length}&preview=1`);
    assert.match(await p.locator('#m5 img.att-img').getAttribute('src'), /^blob:http:\/\/127\.0\.0\.1:/);
    assert.ok(f.requests.some(r => r.path === base + '/ws/images/photo.png' && new URLSearchParams(r.search).get('preview') === '1'));
    assert.equal(await p.locator('#m6 iframe').getAttribute('src'), base + '/ws/demo.html');
    await p.locator('.file').filter({ hasText: 'shared.txt' }).click();
    await p.waitForSelector('.viewer-body pre');
    assert.equal(await p.locator('.viewer-body pre').innerText(), '합성 파일');
    await p.locator('[data-tab="notes"]').click();
    await p.waitForSelector('#wsNotes pre');
    await p.locator('#adminLogin').click();
    await p.locator('#adminPassword').fill('fixture-secret');
    await p.locator('#loginSubmit').click();
    await p.waitForFunction(() => document.body.dataset.role === 'admin' && !document.querySelector('#loginDialog').open);
    const cookie = (await f.context.cookies()).find((cookie) => cookie.name === 'fixture');
    assert.equal(cookie.path, base + '/'); assert.equal(cookie.httpOnly, true);
    assert.equal(await p.locator('#speed .on').getAttribute('data-v'), 'slow');
    assert.equal(await p.locator('#autosleep').inputValue(), '60');
    f.emit('room', { running: false });
    await p.waitForFunction(() => !document.querySelector('#app').classList.contains('running'));
    assert.equal(await p.locator('#speed .on').getAttribute('data-v'), 'slow');
    await p.locator('#speed [data-v="fast"]').click();
    await p.waitForSelector('#speed [data-v="fast"].on');
    assert.ok(f.requests.some((r) => r.path === base + '/api/room' && r.cookie?.includes('fixture=admin')));
    assert.doesNotMatch(await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), /batter|87\.65|fixture-secret/);
    await p.locator('#adminLogout').click();
    await p.waitForFunction(() => document.body.dataset.role === 'viewer');
    assert.equal(await p.locator('.settings').isVisible(), false);
    assert.deepEqual(f.escaped, []); assert.deepEqual(f.errors, []);
    assert.ok(f.requests.some((r) => r.path === base + '/assets/characters/eleven/avatar.png'));
    assert.ok(f.requests.some((r) => r.path === base + '/api/notes'));
  });

  test(`SSE reconnect replaces a gap with latest80 and merges pending updates at ${base || '/'}`, browserOptions, async (t) => {
    const f = await fixture(t, base), p = f.page;
    f.data.messages = Array.from({ length: 610 }, (_, i) => message(i + 1));
    f.holdState(); f.disconnect();
    await until(f.stateHeld);
    f.emit('msg', message(611));
    f.emit('msg', message(611)); // duplicate delivery
    f.emit('msgupdate', { id: 609, reactions: { '👍': ['user'] } });
    f.emit('sleeps', { eleven: { state: 'asleep' } });
    f.emit('room', { running: false, sleeping: true });
    f.releaseState();
    await p.waitForSelector('#m611');
    assert.equal(await p.locator('#m609 .reacts .chip').textContent(), '👍 1');
    assert.equal(await p.locator('.sleep-asleep').count(), 1);
    assert.equal(await p.locator('#app.sleeping').count(), 1);
    const ids = await p.locator('#msgs .msg').evaluateAll(nodes => nodes.map(node => Number(node.id.slice(1))));
    assert.deepEqual(ids, Array.from({ length: 80 }, (_, i) => 532 + i));
    assert.equal(f.requests.filter(r => r.path === base + '/api/history').length, 0);
    assert.equal(f.requests.filter(r => r.path === base + '/api/state').length, 2);
    assert.equal(await p.locator('.settings').isVisible(), false);
    assert.doesNotMatch(await p.locator('#members').innerText(), /87\.65|%|배터리|충전/);
    assert.deepEqual(f.escaped, []); assert.deepEqual(f.errors, []);
  });

  test(`initial80, automatic60, singleflight, anchor and 1000 live events stay within180 at ${base || '/'}`, browserOptions, async t => {
    const f = await fixture(t, base, { messages: Array.from({ length: 1000 }, (_, i) => message(i + 1)) }), p = f.page;
    const historyCalls = () => f.requests.filter(r => r.path === base + '/api/history');
    assert.equal(await p.locator('#msgs .msg').count(), 80);
    assert.equal(await p.locator('#m920').count(), 0);
    assert.equal(await p.locator('#m921').count(), 1);
    assert.equal(historyCalls().length, 0);
    f.holdHistory();
    await p.locator('#timeline').evaluate(node => { node.scrollTop = 0; });
    await until(f.historyHeld);
    const offset = await p.locator('#m921').evaluate(node => node.getBoundingClientRect().top);
    await p.locator('#loadMore').evaluate(node => { for (let i = 0; i < 5; i++) node.click(); });
    await p.waitForTimeout(80);
    assert.equal(historyCalls().length, 1);
    assert.equal(await p.locator('#loadMore').getAttribute('aria-busy'), 'true');
    f.releaseHistory();
    await p.waitForSelector('#m861', { state: 'attached' });
    assert.equal(await p.locator('#msgs .msg').count(), 140);
    assert.ok(Math.abs(await p.locator('#m921').evaluate(node => node.getBoundingClientRect().top) - offset) < 2);
    assert.equal(new URLSearchParams(historyCalls()[0].search).get('limit'), '60');
    assert.equal(new URLSearchParams(historyCalls()[0].search).get('before'), '921');
    for (let id = 1001; id <= 2000; id++) f.emit('msg', { ...message(id), ...(id === 2000 ? { replyTo: 1450 } : {}) });
    await p.waitForFunction(() => document.querySelector('#jump').textContent.includes('1000'));
    assert.ok(await p.locator('#msgs .msg').count() <= 180);
    assert.ok(Math.abs(await p.locator('#m921').evaluate(node => node.getBoundingClientRect().top) - offset) < 2);
    await p.locator('#jump').click();
    await p.waitForSelector('#m2000');
    const ids = await p.locator('#msgs .msg').evaluateAll(nodes => nodes.map(node => Number(node.id.slice(1))));
    assert.deepEqual(ids, Array.from({ length: 180 }, (_, i) => 1821 + i));
    f.emit('msgupdate', { id: 1450, reactions: { '❤️': ['eleven'] } });
    await p.locator('#m2000 .quote').click();
    await p.waitForSelector('#m1450.hl');
    assert.equal(await p.locator('#m1450 .chip').textContent(), '❤️ 1');
    assert.equal(await p.locator('#msgs .msg').count(), 180);
    // Traverse both measured spacers using the scrollbar, without fetching a gap.
    await p.locator('#timeline').evaluate(node => { node.scrollTop = node.scrollHeight / 2; });
    await p.waitForFunction(() => { const rows = [...document.querySelectorAll('#msgs .msg')]; return +rows[0].id.slice(1) > 1500 && +rows.at(-1).id.slice(1) < 1980; });
    assert.equal(await p.locator('#msgs .msg').count(), 180);
    await p.locator('#jump').click();
    await p.waitForSelector('#m2000');
    assert.equal(historyCalls().length, 1);
    assert.deepEqual(f.escaped, []); assert.deepEqual(f.errors, []);
  });

  test(`history error waits for retry and a reconnect keeps the past separate at ${base || '/'}`, browserOptions, async t => {
    const f = await fixture(t, base, { messages: Array.from({ length: 1000 }, (_, i) => message(i + 1)) }), p = f.page;
    const historyCalls = () => f.requests.filter(r => r.path === base + '/api/history');
    f.failHistory();
    await p.locator('#timeline').evaluate(node => { node.scrollTop = 0; });
    await p.waitForFunction(() => document.querySelector('#loadMore').textContent.includes('다시 시도'));
    await p.waitForTimeout(100);
    assert.equal(historyCalls().length, 1);
    await p.locator('#loadMore').click();
    await p.waitForSelector('#m861', { state: 'attached' });
    assert.equal(historyCalls().length, 2);
    const offset = await p.locator('#m921').evaluate(node => node.getBoundingClientRect().top);
    f.data.messages = Array.from({ length: 1610 }, (_, i) => message(i + 1));
    f.holdState(); f.disconnect(); await until(f.stateHeld);
    f.emit('msg', message(1611)); f.releaseState();
    await p.waitForFunction(() => document.querySelector('#jump').textContent.includes('최근 대화'));
    assert.equal(await p.locator('#m1611').count(), 0);
    assert.ok(Math.abs(await p.locator('#m921').evaluate(node => node.getBoundingClientRect().top) - offset) < 2);
    assert.equal(historyCalls().length, 2);
    await p.locator('#jump').click();
    await p.waitForSelector('#m1611');
    assert.equal(await p.locator('#m921').count(), 0);
    assert.deepEqual(await p.locator('#msgs .msg').evaluateAll(nodes => nodes.map(node => +node.id.slice(1))), Array.from({ length: 80 }, (_, i) => 1532 + i));
    assert.deepEqual(f.escaped, []); assert.deepEqual(f.errors, []);
  });

  test(`world APIs, portrait/gallery images and reconnection at ${base || '/'}`, { ...browserOptions, skip: browserOptions.skip || (!threeRoot && 'Set CHATROOM_THREE_ROOT for offline world checks') }, async (t) => {
    const f = await fixture(t, base, { pathname: '/world.html', world: true }), p = f.page;
    await p.waitForFunction(() => window.__worldRenderStats?.().blocks === 1);
    await p.waitForFunction(() => [...document.querySelectorAll('#who img')].every((img) => img.complete && img.naturalWidth > 0));
    await p.locator('#cameras button').filter({ hasText: '앨범' }).click();
    await until(() => f.requests.some((r) => r.path === base + '/ws/images/photo.png'));
    assert.equal(await p.locator('.top a').getAttribute('href'), base + '/');
    f.data.messages.push({ ...message(5), text: '연결 복구 합성 대화' });
    f.disconnect();
    await p.waitForFunction(() => document.querySelector('#chat').textContent.includes('연결 복구 합성 대화')).catch((error) => {
      throw new Error(`${error.message}\n${JSON.stringify({ errors: f.errors, requests: f.requests })}`);
    });
    assert.equal((await p.evaluate(() => window.__worldRenderStats())).camera, 'album');
    assert.ok(f.requests.filter((r) => r.path === base + '/api/world').length >= 2);
    assert.ok(f.requests.filter((r) => r.path === base + '/events').length >= 2);
    assert.deepEqual(f.escaped, []); assert.deepEqual(f.errors, []);
  });
}
