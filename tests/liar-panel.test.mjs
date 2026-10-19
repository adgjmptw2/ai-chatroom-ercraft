// Synthetic /chat fixtures only; never import the server, engine or AI adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '../public');
const require = createRequire(import.meta.url);
let chromium;
for (const name of [process.env.CHATROOM_PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { ({ chromium } = require(name)); break; } catch { /* use an existing runtime only */ }
}
const executablePath = process.env.CHATROOM_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const options = { timeout: 30000, skip: !chromium && 'Set CHATROOM_PLAYWRIGHT_MODULE; no browser download is attempted' };
const NOW = 1791000000000;
const ids = ['adina', 'bianca', 'eleven', 'lucia'];
const names = ['아디나', '비앙카', '일레븐', '루치아'];
const members = ids.map((id, i) => ({ id, name: names[i], color: ['#7267b5', '#cd7196', '#d48655', '#6082b3'][i], status: 'idle', enabled: true, available: true }));
const key = 'ercraft:liar:prediction:v1:/chat';
const view = (patch = {}) => ({ version: 1, revision: 1, serverNow: NOW, nextStartAt: NOW + 3600000, noticeAt: NOW + 3000000, round: null, ...patch });
const round = (patch = {}) => ({ id: 'synthetic-round-1', status: 'active', phase: 'clue', category: '일상 물건', players: ids,
  turn: 'adina', step: 0, totalSteps: 13, startedAt: NOW - 30000, deadlineAt: NOW + 1200000,
  clues: [{ actor: 'adina', phase: 'clue', text: '비가 오는 날 떠올라요.' }], submitted: [], result: null, ...patch });
const result = (patch = {}) => ({ outcome: 'citizens', liar: 'bianca', word: '우산', votes: [
  { actor: 'adina', target: 'bianca' }, { actor: 'bianca', target: 'adina' },
  { actor: 'eleven', target: 'bianca' }, { actor: 'lucia', target: 'bianca' },
], guess: '장화', ...patch });
const done = (patch = {}) => round({ status: 'finished', phase: 'finished', turn: null, step: 13, result: result(), ...patch });
async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'fixture condition timed out');
}

async function fixture(t, { app = false, initial = view(), viewport = { width: 1440, height: 1000 }, clock = false, storage } = {}) {
  const requests = [], errors = [], unexpected = [], clients = new Set(), held = [];
  const data = { room: { running: true, sleeping: false, roomName: '합성 관전방', dev: { online: false } },
    members: structuredClone(members), messages: Array.from({ length: 80 }, (_, i) => ({ id: i + 1, ts: NOW + i, from: 'eleven', text: `합성 대화 ${i + 1}` })),
    files: [], sleeps: {}, liar: initial };
  let hold = false, admin = false;
  const session = () => ({ role: admin ? 'admin' : 'viewer', authenticated: admin });
  const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, method: req.method });
    if (!url.pathname.startsWith('/chat/')) { unexpected.push(req.url); res.writeHead(404); return res.end(); }
    const route = url.pathname.slice(5);
    if (/^\/assets\/characters\/(?:eleven|adina|lucia|bianca|dev)\/(?:avatar|full)\.png$/.test(route)) {
      // Optional art is absent in a public checkout; initials remain visible.
      res.writeHead(404); return res.end();
    }
    if (route === '/api/state') {
      const snapshot = structuredClone({ ...data, session: session() });
      if (hold) { hold = false; held.push(() => json(res, snapshot)); }
      else json(res, snapshot);
      return;
    }
    if (route === '/api/admin/settings') return json(res, { speed: 'slow', autoSleepMin: 0 });
    if (route === '/api/admin/login') { for await (const chunk of req) void chunk; admin = true; return json(res, session()); }
    if (route === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(`retry: 30\nevent: session\ndata: ${JSON.stringify(session())}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (route === '/ercraft-symbol.png' || route === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (route === '/panel') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html lang="ko"><head><meta name="chatroom-base" content="/chat"><link rel="stylesheet" href="/chat/style.css"></head>
        <body><main class="chat" style="height:100dvh"><header class="chat-head">합성 관전</header><div id="host"></div></main>
        <script type="module">import { createLiarPanel } from './liar-panel.js'; import { setPersonaMembers } from './persona-client.js';
        window.setMembers = setPersonaMembers;
        window.makePanel = () => window.panel = createLiarPanel({host:document.querySelector('#host')}); window.makePanel();</script></body></html>`);
    }
    const file = path.resolve(root, ['/', '/admin'].includes(route) ? 'index.html' : route.slice(1));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || req.method !== 'GET') {
      unexpected.push(req.url); res.writeHead(404); return res.end();
    }
    let source = fs.readFileSync(file);
    const ext = path.extname(file);
    if (ext === '.html') source = source.toString().replace('<head>', '<head><meta name="chatroom-base" content="/chat">')
      .replace(/\b(href|src|action)=(['"])\/(?!\/)/g, '$1=$2/chat/');
    res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[ext] || 'application/octet-stream' });
    res.end(source);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const client of clients) client.end(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  if (storage !== undefined) await page.addInitScript(({ key, storage }) => {
    if (storage === 'denied') Object.defineProperty(window, 'localStorage', { get() { throw new Error('synthetic denied'); } });
    else localStorage.setItem(key, storage);
  }, { key, storage });
  if (clock) await page.clock.install({ time: NOW });
  await page.goto(origin + '/chat/' + (app ? '' : 'panel'));
  if (app) {
    await page.waitForSelector('#members .member'); await until(() => clients.size > 0);
  } else {
    await page.waitForFunction(() => !!window.panel);
    await page.evaluate(({ members, initial }) => { window.setMembers(members); window.panel.update(initial); }, { members, initial });
  }
  if (clock) await page.clock.pauseAt(NOW + 1000);
  t.after(() => { assert.deepEqual(errors, [], 'browser errors'); assert.deepEqual(unexpected, [], 'unexpected fixture/network routes'); });
  return { page, requests, data, errors,
    update: value => page.evaluate(value => window.panel.update(value), value),
    emit: (event, value) => { for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); },
    disconnect: () => { for (const client of clients) client.end(); clients.clear(); },
    hold: () => { hold = true; }, held: () => held.length, release: () => held.shift()?.(),
    expire: () => { admin = false; }, connected: () => clients.size,
  };
}

test('next time is discoverable before warning; ten-minute countdown is local, visibility-aware and disposable', options, async t => {
  const f = await fixture(t, { clock: true }), p = f.page;
  const scheduled = view({ serverNow: NOW + 1000, nextStartAt: NOW + 661000, noticeAt: NOW + 61000 });
  await f.update(scheduled);
  assert.equal(await p.locator('.liar-banner').isVisible(), false);
  assert.match(await p.locator('.liar-schedule').innerText(), /다음 예정/);
  assert.equal(await p.locator('.liar-panel').getAttribute('open'), null);
  await p.clock.runFor(60000);
  assert.equal(await p.locator('.liar-countdown').innerText(), '10:00');
  assert.equal(await p.locator('.liar-panel').evaluate(e => e.classList.contains('liar-warning')), true);
  const requestCount = f.requests.length;
  await p.evaluate(() => { window.bodyMutations = 0; new MutationObserver(records => window.bodyMutations += records.length).observe(document.querySelector('.liar-body'), { subtree: true, childList: true, characterData: true }); });
  await p.clock.runFor(3000);
  assert.equal(await p.locator('.liar-countdown').innerText(), '9:57');
  assert.equal(await p.evaluate(() => window.bodyMutations), 0);
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await p.clock.runFor(5000);
  assert.equal(await p.locator('.liar-countdown').innerText(), '9:57');
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await p.locator('.liar-countdown').innerText(), '9:52');
  await p.clock.runFor(592000);
  assert.equal(await p.locator('.liar-banner').isVisible(), false);
  assert.match(await p.locator('.liar-status').innerText(), /시작 여부 확인 중/);
  assert.equal(await p.locator('.liar-content').innerText(), '');
  assert.equal(f.requests.length, requestCount, 'no countdown polling or network heartbeat');
  await p.evaluate(() => window.panel.dispose()); await p.clock.runFor(1000);
  assert.equal(await p.locator('.liar-panel').count(), 0);
});

test('active clues and local choices survive refresh, close with voting, and reveal only actual finished results', options, async t => {
  const active = round({ result: result(), word: '비공개-가짜정답', role: 'liar' });
  const f = await fixture(t, { initial: view({ round: active }) }), p = f.page;
  assert.equal(await p.locator('.liar-panel').getAttribute('open'), null);
  await p.locator('.liar-summary').click();
  assert.match(await p.locator('.liar-status').innerText(), /아디나 차례/);
  assert.doesNotMatch(await p.locator('.liar-panel').textContent(), /우산|비공개-가짜정답|라이어:|시민 승리/);
  assert.equal(await p.locator('.liar-choice').count(), 4);
  const requestCount = f.requests.length;
  await p.getByRole('button', { name: '아디나', exact: true }).click();
  await p.getByRole('button', { name: '비앙카', exact: true }).click();
  assert.equal(await p.getByRole('button', { name: '비앙카', exact: true }).getAttribute('aria-pressed'), 'true');
  let saved = await p.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  assert.equal(saved.actor, 'bianca'); assert.equal(saved.roundId, active.id);
  assert.ok(JSON.stringify(saved).length < 1024);
  assert.doesNotMatch(JSON.stringify(saved), /word|votes|role|우산/);
  await p.evaluate(() => { window.panel.dispose(); window.makePanel(); });
  await f.update(view({ serverNow: NOW + 1000, round: active }));
  await p.locator('.liar-summary').click();
  assert.equal(await p.getByRole('button', { name: '비앙카', exact: true }).getAttribute('aria-pressed'), 'true');
  await p.getByRole('button', { name: '비앙카', exact: true }).focus();
  await p.evaluate(() => window.originalButton = document.activeElement);
  await f.update(view({ serverNow: NOW + 1000, round: active }));
  assert.equal(await p.evaluate(() => window.originalButton === document.activeElement), true);
  await f.update(view({ revision: 2, serverNow: NOW + 2000, round: round({ phase: 'discussion', turn: 'lucia', step: 5,
    clues: [...active.clues, { actor: 'lucia', phase: 'discussion', text: '손에 들고 쓸까요?' }] }) }));
  assert.match(await p.locator('.liar-clues').innerText(), /질문·토론[\s\S]*손에 들고/);
  await f.update(view({ revision: 3, serverNow: NOW + 3000, round: round({ phase: 'vote', submitted: ['adina', 'eleven'], step: 10 }) }));
  assert.match(await p.locator('.liar-vote-progress').innerText(), /2\/4명/);
  assert.equal(await p.getByRole('button', { name: '비앙카', exact: true }).isEnabled(), true);
  await f.update(view({ revision: 4, serverNow: NOW + 4000, round: round({ phase: 'vote', submitted: ids, step: 12 }) }));
  assert.equal(await p.getByRole('button', { name: '비앙카', exact: true }).isEnabled(), false);
  await f.update(view({ revision: 5, serverNow: NOW + 5000, round: round({ phase: 'guess', turn: 'bianca', result: result() }) }));
  assert.equal(await p.locator('.liar-result').count(), 0);
  assert.doesNotMatch(await p.locator('.liar-panel').textContent(), /우산|라이어:|장화/);
  await f.update(view({ revision: 6, serverNow: NOW + 6000, round: done() }));
  assert.match(await p.locator('.liar-result').innerText(), /시민 승리[\s\S]*라이어: 비앙카[\s\S]*정답: 우산[\s\S]*비앙카 3표/);
  assert.match(await p.locator('.liar-verdict').innerText(), /라이어를 맞혔어요/);
  assert.equal(await p.locator('.liar-choice').count(), 0);
  assert.equal(f.requests.length, requestCount, 'personal choices cause no requests');
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, 0);
});

test('ties, missing results and cancelled rounds never invent a winner or spectator correctness', options, async t => {
  const f = await fixture(t), p = f.page;
  await f.update(view({ revision: 2, round: done({ result: null }) }));
  await p.locator('.liar-summary').click();
  assert.match(await p.locator('.liar-result-pending').innerText(), /공개 결과/);
  assert.equal(await p.locator('.liar-reveal-word').count(), 0);
  const tie = result({ outcome: 'draw', guess: undefined, votes: [
    { actor: 'adina', target: 'bianca' }, { actor: 'eleven', target: 'bianca' },
    { actor: 'bianca', target: 'adina' }, { actor: 'lucia', target: 'adina' },
  ] });
  await f.update(view({ revision: 3, round: done({ result: tie }) }));
  assert.equal(await p.locator('.liar-result h3').innerText(), '무승부');
  assert.match(await p.locator('.liar-tally').innerText(), /아디나 2표 · 비앙카 2표/);
  assert.match(await p.locator('.liar-verdict').innerText(), /마감 전에 고른 추측이 없습니다/);
  assert.doesNotMatch(await p.locator('.liar-result').innerText(), /승리|맞혔어요/);
  await f.update(view({ revision: 4, round: done({ result: result({ outcome: 'cancelled', liar: null, word: null, votes: [], reason: '진행을 마쳤습니다.' }) }) }));
  assert.equal(await p.locator('.liar-result h3').innerText(), '게임 중단');
  assert.equal(await p.locator('.liar-reveal-role, .liar-reveal-word, .liar-tally').count(), 0);
  await f.update(null);
  assert.match(await p.locator('.liar-status').innerText(), /확인할 수 없어요/);
  assert.match(await p.locator('.liar-schedule').innerText(), /일정 확인 중/);
});

test('hostile names, clues, category, result and reason are literal text, with no HTML or overflow', options, async t => {
  const malicious = '<img src=x onerror="window.__liarXss=1"><svg onload="window.__liarXss=2"></svg>';
  const f = await fixture(t, { viewport: { width: 360, height: 740 } }), p = f.page;
  await p.evaluate(({ members, malicious }) => window.setMembers(members.map(m => ({ ...m, name: malicious }))), { members, malicious });
  await f.update(view({ round: round({ category: malicious, clues: [{ actor: 'adina', phase: 'clue', text: malicious.repeat(4) }] }) }));
  await p.locator('.liar-summary').click();
  assert.match(await p.locator('.liar-clues').innerText(), /<img src=x onerror=/);
  await f.update(view({ revision: 2, round: done({ result: result({ word: malicious, reason: malicious, guess: malicious }) }) }));
  assert.match(await p.locator('.liar-reveal-word').innerText(), /<svg onload=/);
  assert.equal(await p.locator('.liar-panel img, .liar-panel svg, .liar-panel script, .liar-panel iframe').count(), 0);
  assert.equal(await p.evaluate(() => window.__liarXss), undefined);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});

test('one bounded prediction clears on new game; late arrivals, stale records and denied storage stay truthful', options, async t => {
  const f = await fixture(t, { initial: view({ round: round() }), storage: '{broken' }), p = f.page;
  await p.locator('.liar-summary').click();
  assert.equal(await p.evaluate(key => localStorage.getItem(key), key), null);
  await p.getByRole('button', { name: '아디나', exact: true }).click();
  await f.update(view({ revision: 2, round: round({ id: 'synthetic-round-2', startedAt: NOW - 1000 }) }));
  assert.equal(await p.evaluate(key => localStorage.getItem(key), key), null);
  await f.update(view({ revision: 3, round: done({ id: 'synthetic-round-2', startedAt: NOW - 1000 }) }));
  await p.locator('.liar-summary').click();
  assert.match(await p.locator('.liar-verdict').innerText(), /추측이 없습니다/);
  await p.evaluate(({ key, NOW }) => localStorage.setItem(key, JSON.stringify({ version: 1, roundId: 'synthetic-round-1', actor: 'bianca', startedAt: NOW - 30000, chosenAt: NOW + 60000, revision: 1, closed: false })), { key, NOW });
  await p.evaluate(() => { window.panel.dispose(); window.makePanel(); });
  await f.update(view({ revision: 4, round: done() }));
  await p.locator('.liar-summary').click();
  assert.match(await p.locator('.liar-verdict').innerText(), /추측이 없습니다/);
  assert.equal(await p.evaluate(key => localStorage.getItem(key), key), null);
  const denied = await fixture(t, { initial: view({ round: round() }), storage: 'denied' });
  await denied.page.locator('.liar-summary').click();
  await denied.page.getByRole('button', { name: '비앙카', exact: true }).click();
  assert.match(await denied.page.locator('.liar-local-note').innerText(), /화면에서만 유지/);
  await denied.update(view({ revision: 2, serverNow: NOW + 10000, round: done() }));
  assert.match(await denied.page.locator('.liar-verdict').innerText(), /맞혔어요/);
});

test('/chat app wires state and liar SSE once, preserves personal choice through reconnect and prefers pending SSE', options, async t => {
  const f = await fixture(t, { app: true, initial: view({ round: round() }) }), p = f.page;
  assert.equal(await p.locator('.liar-panel').count(), 1);
  assert.equal(await p.locator('#msgs .msg').count(), 80);
  assert.equal(await p.locator('#input').getAttribute('readonly'), '');
  assert.equal(await p.locator('.world-link').getAttribute('href'), '/chat/world.html');
  await p.locator('.liar-summary').click();
  await p.getByRole('button', { name: '비앙카', exact: true }).click();
  // Reusing the same public view during an identity update cannot rewind time
  // and erase a choice made after that view was received.
  f.emit('members', members.map(m => m.id === 'adina' ? { ...m, name: '아디나·합성' } : m));
  await p.getByRole('button', { name: '아디나·합성', exact: true }).waitFor();
  assert.equal(await p.getByRole('button', { name: '비앙카', exact: true }).getAttribute('aria-pressed'), 'true');
  f.hold(); f.disconnect(); await until(() => f.held() === 1);
  f.emit('liar', view({ revision: 3, serverNow: NOW + 3000, round: round({ phase: 'discussion', turn: 'lucia', step: 4 }) }));
  await p.waitForFunction(() => document.querySelector('.liar-status').textContent.includes('루치아'));
  f.release();
  await p.waitForFunction(() => document.querySelectorAll('#msgs .msg').length === 80);
  assert.match(await p.locator('.liar-status').innerText(), /질문·토론 · 루치아 차례/);
  assert.equal(await p.getByRole('button', { name: '비앙카', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await p.getByRole('button', { name: '비앙카', exact: true }).isEnabled(), true);
  f.emit('liar', view({ revision: 2, round: round({ turn: 'eleven' }) }));
  f.emit('room', { running: false, sleeping: true }); await p.waitForSelector('#app.sleeping');
  assert.match(await p.locator('.liar-status').innerText(), /루치아/);
  f.emit('liar', view({ revision: 4, serverNow: NOW + 4000, round: done() }));
  await p.waitForSelector('.liar-result');
  assert.match(await p.locator('.liar-verdict').innerText(), /맞혔어요/);
  assert.equal(await p.locator('.liar-panel').count(), 1);
  assert.equal(f.requests.filter(r => r.path === '/chat/api/state').length, 2);
  assert.equal(f.requests.filter(r => r.path === '/chat/api/liar' || r.method !== 'GET').length, 0);
  assert.ok(f.requests.some(r => r.path === '/chat/liar-panel.js'));
});

test('expired session rejects an older held admin snapshot including its liar state', options, async t => {
  const f = await fixture(t, { app: true, initial: view({ round: round() }) }), p = f.page;
  await p.locator('#adminLogin').click(); await p.locator('#adminPassword').fill('synthetic-only'); await p.locator('#loginSubmit').click();
  await p.waitForFunction(() => document.body.dataset.role === 'admin');
  await until(() => f.requests.filter(r => r.path === '/chat/events').length >= 2 && f.connected() === 1);
  f.hold(); f.disconnect(); await until(() => f.held() === 1);
  f.expire();
  f.data.liar = view({ revision: 5, serverNow: NOW + 5000, round: round({ phase: 'vote', turn: 'eleven', submitted: ['adina'] }) });
  f.emit('session', { role: 'viewer', authenticated: false });
  await p.waitForFunction(() => document.body.dataset.role === 'viewer' && document.querySelector('.liar-status').textContent.includes('비공개 투표'));
  f.release(); await p.waitForTimeout(100);
  assert.match(await p.locator('.liar-status').innerText(), /비공개 투표/);
  assert.equal(await p.locator('#input').getAttribute('readonly'), '');
  assert.equal(await p.locator('#send').isDisabled(), true);
  assert.equal(await p.locator('.liar-panel').count(), 1);
  assert.deepEqual(f.requests.filter(r => r.method === 'POST').map(r => r.path), ['/chat/api/admin/login']);
});

test('mobile and wide chat keep input and world navigation unobscured even with an expanded active game', options, async t => {
  const f = await fixture(t, { app: true, initial: view({ round: round() }), viewport: { width: 390, height: 844 } }), p = f.page;
  assert.equal(await p.locator('.liar-panel').getAttribute('open'), null);
  await p.locator('.liar-summary').click();
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 1440, height: 1000 }]) {
    await p.setViewportSize(viewport);
    const geometry = await p.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const input = rect('#input'), nav = rect('.world-link');
      return { panel: rect('.liar-panel'), chat: rect('.chat'), timeline: rect('#timeline'), input, nav,
        inputHit: document.elementFromPoint(input.x + input.width / 2, input.y + input.height / 2)?.id,
        navHit: !!document.elementFromPoint(nav.x + nav.width / 2, nav.y + nav.height / 2)?.closest('.world-link'),
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.inputHit, 'input'); assert.equal(geometry.navHit, true);
    assert.ok(geometry.panel.bottom <= geometry.timeline.y + 1);
    assert.ok(geometry.panel.x >= geometry.chat.x && geometry.panel.right <= geometry.chat.right);
    assert.ok(geometry.timeline.height >= 120, JSON.stringify(geometry));
  }
});
