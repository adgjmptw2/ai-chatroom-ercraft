// Browser checks use local Playwright or the bundled Codex runtime. Override
// CHATROOM_PLAYWRIGHT_MODULE / CHATROOM_BROWSER for another installation.
// Uses a random loopback port, synthetic API/SSE data, and no runtime files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sessionView, sleepView, systemText } from '../public/presentation.js';
import { DICT } from '../public/i18n.js';
import { AI_IDS, MEMBERS } from '../lib/members.mjs';
import { publicMember } from '../lib/public-view.mjs';
import { tinyPng } from './privacy-fixtures.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
for (const module of [process.env.CHATROOM_PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')].filter(Boolean)) {
  try { ({ chromium } = require(module)); break; } catch { /* try the next installed runtime */ }
}
const executablePath = process.env.CHATROOM_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const tr = (key) => DICT.ko[key];
const privateIdentity = /claude|chatgpt|gpt|grok|gemini|deepseek|anthropic|openai|\bxai\b|\bhive\b|legacyAliases|imageVision|imageGen|defaultModel/i;
const threeRoot = process.env.CHATROOM_THREE_ROOT;

test('session display defaults to viewer unless both admin and authenticated are confirmed', () => {
  for (const value of [null, {}, { role: 'admin' }, { role: 'admin', authenticated: 'true' }, { role: 'viewer', authenticated: true }]) {
    assert.deepEqual(sessionView(value), { role: 'viewer', authenticated: false });
  }
  assert.deepEqual(sessionView({ role: 'admin', authenticated: true }), { role: 'admin', authenticated: true });
});

test('sleep labels respect actual sleep and never infer capacity from stale or malformed data', () => {
  for (const state of ['awake', 'resting', 'asleep', 'unknown']) for (const level of [0, 1, 2, 3, 4, null, undefined, -1, 5, '3', 1.5]) {
    const v = sleepView({ state, level, remainingPct: 92.7, resetAt: 999999, model: 'private-model' }, tr);
    assert.equal(v.state, state);
    assert.equal(v.label, tr(`sleep.${state}`));
    assert.doesNotMatch(v.label, /\d|%|private|모델|초기화|호출|배터리|충전/);
    assert.deepEqual(Object.keys(v).sort(), ['label', 'state']);
  }
  for (const state of ['ready', 'stale', 'error', 'needsSleep', 'drowsy']) {
    for (let level = 0; level <= 4; level++) assert.equal(sleepView({ state, level }, tr).state, 'unknown');
  }
  for (const condition of [undefined, null, {}, { status: 'sleeping' }, { status: 'off', enabled: false }, { level: 4 }]) {
    assert.deepEqual(sleepView(condition, tr), { state: 'unknown', label: tr('sleep.unknown') });
  }
});

test('localized access copy is complete and ordinary spoken messages are preserved', () => {
  for (const lang of ['ko', 'en', 'ja']) {
    for (const key of Object.keys(DICT.ko).filter((k) => /^(auth|sleep|footer)\./.test(k))) assert.equal(typeof DICT[lang][key], 'string', lang + ':' + key);
    assert.equal(DICT[lang]['user.default'], 'ERCraft');
    assert.match(DICT[lang]['app.title'], /ERCraft/);
  }
  const message = { from: 'eleven', text: '내 말투는 그대로야. gpt-test도 이야기할 수 있어.' };
  assert.equal(systemText(message, '일레븐', tr), message.text);
});

async function fixture(t, { scripting = true, admin = false, pathname = '/', portraitMode = 'synthetic' } = {}) {
  const calls = [], clients = new Set(), errors = [], payloads = [], requests = [];
  const worldPage = pathname.startsWith('/world.html');
  let active = admin, heldState = null, nextHold = false;
  const room = { running: false, sleeping: false, roomName: 'legacy room', userName: 'legacy host', lang: 'ko', dev: { online: false } };
  const settings = { speed: 'slow', autoSleepMin: 60, boostMode: 'manual', calls: 7341 };
  const ids = ['eleven', 'adina', 'lucia', 'bianca'];
  const members = AI_IDS.map((id) => publicMember({ id, ...MEMBERS[id], status: 'idle', enabled: true, available: true }));
  const art = new Set([...ids, 'dev'].flatMap(id => ['full', 'avatar'].map(kind => `/assets/characters/${id}/${kind}.png`)));
  const portrait = tinyPng();
  const world = { size: { x: 48, y: 32, z: 48 }, palette: { planks: ['p', '#c8a063'], lamp: ['L', '#ffe9a0'] },
    blocks: ['chair', 'table', 'bench', 'bed', 'workbench'].map((shape, i) => [12 + 2 * i, 1, 16, `planks/${shape}/n`]).concat([[12, 1, 12, 'lamp']]),
    avatars: Object.fromEntries([...ids, 'former-member', 'dev'].map((id, i) => [id, { x: 12 + 2 * i, y: 1, z: 18,
      posture: ['lie', 'sit', 'stand', 'work', 'stand', 'stand'][i], facing: 'n' }])), signs: {}, custom: {} };
  const session = (req) => ({ role: active && req.headers.cookie?.includes('fixture=admin') ? 'admin' : 'viewer', authenticated: !!(active && req.headers.cookie?.includes('fixture=admin')) });
  const state = (req) => ({ session: session(req), room: { ...room },
    members,
    messages: [{ id: 1, ts: 1700000000000, from: 'user', text: '공개 방장 메시지', reactions: { '👍': ['user'] } },
      { id: 2, ts: 1700000060000, from: 'eleven', text: '내 말투는 그대로야.', reactions: { '👍': ['user'] } }],
    files: [{ path: 'shared.txt', size: 12, mtime: 1700000000000, by: 'eleven' }],
    sleeps: Object.fromEntries(ids.map((id) => [id, { state: 'awake' }])),
    // Adversarial legacy payload: the client must not render it even for admin.
    usage: { eleven: { windows: [{ remainingPct: 87.65 }], calls30: 7341 } },
  });
  const json = (res, value, code = 200) => { const body = JSON.stringify(value); payloads.push(body); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(`event: session\ndata: ${JSON.stringify(session(req))}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (url.pathname === '/api/state') {
      const snapshot = state(req);
      if (nextHold) { nextHold = false; heldState = () => { json(res, snapshot); heldState = null; }; }
      else json(res, snapshot);
      return;
    }
    if (url.pathname === '/api/notes') return json(res, { eleven: '메모 원문은 그대로야.' });
    if (url.pathname === '/api/world') return json(res, world);
    if (url.pathname === '/api/file') return json(res, { text: '공개 파일 원문' });
    if (url.pathname === '/api/session') return json(res, session(req));
    if (url.pathname === '/api/admin/settings') return session(req).authenticated ? json(res, { ...room, ...settings }) : json(res, { error: 'admin required' }, 401);
    if (art.has(url.pathname)) {
      if (portraitMode === 'missing') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(portraitMode === 'broken' ? 'invalid synthetic image' : portrait);
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); calls.push({ path: url.pathname, body });
      if (url.pathname === '/api/admin/login') {
        if (body.password !== 'fixture-secret') return json(res, { error: 'private diagnostic' }, 401);
        active = true; res.setHeader('Set-Cookie', 'fixture=admin; HttpOnly; SameSite=Strict; Path=/');
        return json(res, { role: 'admin', authenticated: true });
      }
      if (url.pathname === '/api/admin/logout') { active = false; res.setHeader('Set-Cookie', 'fixture=; Max-Age=0; Path=/'); return json(res, { role: 'viewer', authenticated: false }); }
      if (!session(req).authenticated) return json(res, { error: 'admin required' }, 403);
      if (url.pathname === '/api/room') {
        Object.assign(settings, body);
        if (typeof body.running === 'boolean') room.running = body.running;
        return json(res, { ...room, ...settings });
      }
      return json(res, { ok: true, running: room.running });
    }
    const relative = url.pathname === '/' || url.pathname === '/admin' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { for (const res of clients) res.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true, executablePath, args: worldPage ? ['--enable-unsafe-swiftshader'] : [] });
  t.after(() => browser.close());
  const context = await browser.newContext({ javaScriptEnabled: scripting, viewport: { width: 1440, height: 1000 } });
  await context.route('https://**/*', async (route) => {
    const prefix = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';
    const url = route.request().url();
    if (worldPage && threeRoot && url.startsWith(prefix)) {
      const file = path.resolve(threeRoot, url.slice(prefix.length));
      if (file.startsWith(path.resolve(threeRoot) + path.sep) && fs.existsSync(file)) {
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
      }
    }
    return route.abort();
  });
  if (admin) await context.addCookies([{ name: 'fixture', value: 'admin', url, httpOnly: true }]);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(url + pathname);
  if (scripting) await page.waitForSelector(worldPage ? '#who button' : '#members .member');
  return { page, calls, errors, url, members, payloads, requests,
    emit: (event, data) => { const body = JSON.stringify(data); payloads.push(body); for (const res of clients) res.write(`event: ${event}\ndata: ${body}\n\n`); },
    expire: () => { active = false; },
    holdNextState: () => { nextHold = true; },
    releaseState: () => heldState?.(),
    stateHeld: () => !!heldState,
  };
}

const browserOptions = { skip: !chromium && 'Set CHATROOM_PLAYWRIGHT_MODULE to run browser checks' };
const worldOptions = { skip: browserOptions.skip || (!threeRoot && 'Set CHATROOM_THREE_ROOT to an unpacked Three.js 0.170.0 package for offline world checks') };
async function login(page) {
  if (!await page.locator('#loginDialog').isVisible()) await page.locator('#adminLogin').click();
  await page.locator('#adminPassword').fill('fixture-secret');
  await page.locator('#loginSubmit').click();
  await page.waitForFunction(() => document.body.dataset.role === 'admin' && !document.querySelector('#loginDialog').open);
}

test('initial HTML hides admin controls and usage before any JavaScript or session response', browserOptions, async (t) => {
  const { page } = await fixture(t, { scripting: false });
  for (const selector of ['.settings', '#meTag', '#attachBtn', '#stickerBtn', '#send', '[data-tab="usage"]', '#wsUsage']) assert.equal(await page.locator(selector).isVisible(), false, selector);
  assert.equal(await page.locator('#power').isVisible(), true);
  assert.equal(await page.locator('#power').isDisabled(), true);
  assert.equal(await page.locator('#input').getAttribute('readonly'), '');
  assert.equal(await page.title(), 'ERCraft 단톡방');
  assert.equal(await page.locator('#loginForm').getAttribute('method'), 'post', 'passwords must never fall back to URL submission');
});

test('viewer can read chat/files/notes, sees sleep labels, and cannot trigger privileged UI', browserOptions, async (t) => {
  const f = await fixture(t), p = f.page;
  assert.equal(await p.title(), 'ERCraft 단톡방');
  assert.equal(await p.locator('#meName').textContent(), 'ERCraft');
  assert.equal(await p.locator('#m1 .m-head .n').textContent(), 'ERCraft');
  assert.equal(await p.locator('#m2 .text').textContent(), '내 말투는 그대로야.');
  assert.equal(await p.locator('.switch').count(), 0);
  assert.equal(await p.locator('.reacts:visible').count(), 2);
  assert.equal(await p.locator('#m1 .reacts .chip').textContent(), '👍 1');
  assert.equal(await p.locator('#m1 .reacts .chip').isDisabled(), true);
  assert.equal(await p.locator('#m1 .reacts .chip').evaluate((node) => node.onclick), null);
  assert.equal(await p.locator('.member-sleep').count(), 4);
  assert.equal(await p.locator('.member-sleep.sleep-awake').count(), 4);
  assert.equal(await p.locator('.member-battery, .battery-shell, .member-sleep button, .member-sleep a, .member-sleep[title]').count(), 0);
  const memberCopy = await p.locator('#members').evaluate((node) => node.textContent + [...node.querySelectorAll('[title], [aria-label]')].map((el) => el.title + el.getAttribute('aria-label')).join(' '));
  assert.doesNotMatch(memberCopy, /7341|9876|87\.65|private-model|%|resetAt/);
  await p.evaluate(() => {
    document.querySelector('#power').onclick();
    document.querySelector('#input').value = 'cannot impersonate';
    document.querySelector('#send').onclick();
    document.querySelector('[data-tab="usage"]').onclick();
  });
  assert.equal(f.calls.length, 0);
  assert.equal(await p.locator('#wsUsage').isVisible(), false);
  await p.locator('.file').click();
  await p.waitForSelector('.viewer-body pre');
  assert.equal(await p.locator('.viewer-body pre').textContent(), '공개 파일 원문');
  await p.locator('[data-tab="notes"]').click();
  await p.waitForFunction(() => document.querySelector('#wsNotes').textContent.includes('메모 원문은 그대로야.'));
  f.emit('sleeps', { eleven: { state: 'asleep' }, adina: { state: 'resting' }, lucia: { state: 'awake' }, bianca: { state: 'unknown' } });
  await p.waitForFunction(() => ['asleep', 'resting', 'awake', 'unknown'].every((state) => document.querySelectorAll(`.member-sleep.sleep-${state}`).length === 1));
  f.emit('sleeps', { eleven: { state: 'stale', level: 4 } });
  await p.waitForFunction(() => document.querySelectorAll('.member-sleep.sleep-unknown').length === 4);
  assert.equal(await p.locator('.member-sleep .filled, .battery-shell').count(), 0);
  assert.equal(await p.locator('.member-sleep').evaluateAll((nodes) => nodes.every((node) => {
    const indicator = node.getBoundingClientRect(), member = node.closest('.member').getBoundingClientRect();
    return indicator.top >= member.top && indicator.bottom <= member.bottom && indicator.left >= member.left && indicator.right <= member.right;
  })), true, 'sleep labels must remain inside their own member row');
  assert.deepEqual(f.errors, []);
});

test('public portraits, descriptions, notes and member SSE use character identities without capability hints', browserOptions, async (t) => {
  const f = await fixture(t), p = f.page;
  await p.waitForFunction(() => [...document.querySelectorAll('#brandAvatars img')].length === 4
    && [...document.querySelectorAll('#brandAvatars img, #members img')].every((img) => img.dataset.sharedState === 'ready' && img.complete && img.naturalWidth > 0));
  const portraits = await p.locator('#brandAvatars img').evaluateAll(imgs => imgs.map(img => ({
    source: img.dataset.sharedSrc, src: img.src, protocol: new URL(img.src).protocol, origin: new URL(img.src).origin,
    width: img.naturalWidth, height: img.naturalHeight, visible: getComputedStyle(img).visibility,
    fallback: getComputedStyle(img.nextElementSibling).visibility,
  })));
  assert.deepEqual(portraits.map(img => img.source), f.members.map(m => `${m.persona.skin.avatar}?preview=1`));
  for (const img of portraits) {
    assert.equal(img.protocol, 'blob:');
    assert.equal(img.origin, new URL(f.url).origin);
    assert.equal(img.width, 1, 'the synthetic PNG must decode');
    assert.equal(img.height, 1);
    assert.equal(img.visible, 'visible');
    assert.equal(img.fallback, 'hidden');
  }
  assert.deepEqual(await p.locator('#members .member:not(.dev) img').evaluateAll(imgs => imgs.map(img => img.src)), portraits.map(img => img.src), 'copies share the same decoded Blob URL');
  for (const { source } of portraits) assert.equal(f.requests.filter(request => new URL(request).pathname + new URL(request).search === source).length, 1, 'one fetch per public preview URL');
  assert.deepEqual(await p.locator('#members .member:not(.dev)').evaluateAll((nodes) => nodes.map((node) => node.title)), f.members.map((m) => m.name));
  assert.deepEqual(await p.locator('#members .member:not(.dev)').evaluateAll((nodes) => nodes.map((node) => node.style.getPropertyValue('--c'))), f.members.map((m) => m.color));
  f.emit('room', { running: true });
  f.emit('members', f.members.map((m, i) => ({ ...m, status: i === 0 ? 'typing' : i === 1 ? 'reading' : 'idle', drawing: i === 0, deep: i === 1 })));
  await p.waitForSelector('#members .member.drawing');
  await p.waitForFunction(() => [...document.querySelectorAll('#members .member:not(.dev) img')].every(img => img.dataset.sharedState === 'ready'));
  assert.deepEqual(await p.locator('#members .member:not(.dev) img').evaluateAll(imgs => imgs.map(img => img.src)), portraits.map(img => img.src), 'SSE remounts reuse the shared Blob');
  assert.match(await p.locator('#members .member.drawing .m-status').textContent(), /그림/);
  assert.match(await p.locator('#members .member.deep .m-status').textContent(), /진심모드/);
  assert.equal(await p.locator('.member-sleep').count(), 4);
  f.emit('msg', { id: 3, ts: 1700000100000, from: 'eleven', text: '사진 설명', attach: { path: 'photo.png', desc: '함께 보는 풍경', upload: true } });
  await p.waitForSelector('#m3 .att-desc');
  assert.equal(await p.locator('#m3 .att-desc').getAttribute('title'), DICT.ko['desc.titleGeneric'] + '\n\n함께 보는 풍경');
  await p.locator('[data-tab="notes"]').click();
  await p.waitForSelector('#wsNotes pre');
  f.emit('notes', { id: 'adina', text: '새 메모 원문' });
  await p.waitForFunction(() => document.querySelector('#wsNotes').textContent.includes('새 메모 원문'));
  assert.equal(await p.locator('#wsNotes pre').first().textContent(), '메모 원문은 그대로야.');
  f.emit('msg', { id: 4, ts: 1700000120000, from: 'former-member', text: '이전 대화' });
  await p.waitForSelector('#m4');
  assert.match(await p.locator('#m4').textContent(), /이전 멤버/);
  assert.equal(await p.locator('#m4 .persona-avatar img').count(), 0);
  assert.doesNotMatch(f.payloads.join('\n'), privateIdentity);
  assert.doesNotMatch(f.requests.join('\n'), /\/avatars\/|\/assets\/characters\/(?:claude|gpt|deepseek|gemini|grok)\//);
  assert.deepEqual(f.errors, []);
});

for (const portraitMode of ['missing', 'broken']) {
  test(`${portraitMode} art shows public initials, preserves labels and handles metadata updates`, browserOptions, async t => {
    const f = await fixture(t, { portraitMode }), p = f.page;
    const selectors = ['#brandAvatars .persona-avatar', '#members .member:not(.dev) .persona-avatar'];
    const initials = f.members.map(m => Array.from(m.name)[0]);
    await p.waitForFunction(() => [...document.querySelectorAll('#brandAvatars img, #members img')].every(img => img.dataset.sharedState === 'failed'));
    for (const selector of selectors) {
      const views = await p.locator(selector).evaluateAll(nodes => nodes.map(node => {
        const initial = node.querySelector('.persona-avatar-initial'), img = node.querySelector('img');
        const frame = node.getBoundingClientRect(), box = initial.getBoundingClientRect(), css = getComputedStyle(initial);
        const range = document.createRange(); range.selectNodeContents(initial);
        const text = range.getBoundingClientRect();
        return { initial: initial.textContent, hidden: initial.getAttribute('aria-hidden'), visibility: css.visibility,
          frame: [frame.width, frame.height], inset: Math.abs(frame.x - box.x) + Math.abs(frame.y - box.y),
          centered: Math.abs((text.x + text.width / 2) - (frame.x + frame.width / 2)) < 2
            && Math.abs((text.y + text.height / 2) - (frame.y + frame.height / 2)) < 3,
          fontSize: parseFloat(css.fontSize), background: css.backgroundImage, image: getComputedStyle(img).visibility, width: img.naturalWidth };
      }));
      assert.deepEqual(views.map(v => v.initial), initials);
      for (const view of views) {
        assert.equal(view.hidden, 'true', 'decorative initials must not duplicate accessible names');
        assert.equal(view.visibility, 'visible');
        assert.ok(view.frame.every(size => size > 0));
        assert.equal(view.inset, 0);
        assert.equal(view.centered, true, 'initial text is centered inside its visible frame');
        assert.ok(view.fontSize > 8 && view.fontSize <= view.frame[0]);
        assert.notEqual(view.background, 'none');
        assert.equal(view.image, 'hidden', 'no broken-image icon may cover the initial');
        assert.equal(view.width, 0);
      }
    }
    assert.equal(await p.locator('#m2 .persona-avatar').getAttribute('aria-label'), f.members[0].name);
    assert.equal(await p.locator('#m2 .persona-avatar-initial').isVisible(), true);
    assert.equal(await p.locator('#members .dev .persona-avatar-initial').textContent(), '나');
    // Removing image metadata must leave a visible initial without making any image request.
    const before = f.requests.filter(request => new URL(request).pathname.startsWith('/assets/characters/')).length;
    f.emit('members', f.members.map(m => ({ ...m, persona: { ...m.persona, skin: {} } })));
    await p.waitForFunction(() => !document.querySelector('#members .member:not(.dev) img'));
    assert.deepEqual(await p.locator('#brandAvatars .persona-avatar-initial').allTextContents(), initials);
    assert.equal(await p.locator('#members .member:not(.dev) .persona-avatar-initial:visible').count(), 4);
    assert.equal(f.requests.filter(request => new URL(request).pathname.startsWith('/assets/characters/')).length, before);
    assert.doesNotMatch(f.payloads.join('\n'), privateIdentity);
    assert.doesNotMatch(f.requests.join('\n'), /\/avatars\/|\/assets\/characters\/(?:claude|gpt|deepseek|gemini|grok)\//);
    assert.deepEqual(f.errors, []);
  });
}

test('standalone avatar styling follows ready and failed cache states without the chat stylesheet', browserOptions, async t => {
  const f = await fixture(t), p = f.page;
  await p.evaluate(async () => {
    const { createAvatar, memberName } = await import('/persona-client.js');
    const avatar = createAvatar('adina', '', memberName('adina'));
    avatar.id = 'standaloneAvatar';
    Object.assign(avatar.style, { width: '40px', height: '40px', position: 'fixed', top: '0', left: '0', zIndex: '9999', borderRadius: '50%' });
    document.body.append(avatar);
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      if (new URL(link.href).pathname.endsWith('/style.css')) link.remove();
    }
  });
  await p.waitForFunction(() => document.querySelector('#standaloneAvatar img').dataset.sharedState === 'ready');
  assert.equal(await p.locator('#standaloneAvatar img').evaluate(img => img.naturalWidth), 1);
  assert.equal(await p.locator('#standaloneAvatar .persona-avatar-initial').isVisible(), false);
  // A new cache key must switch back to its public-name initial if decoding fails.
  const broken = '/assets/characters/adina/avatar.png?preview=1&fixture=broken';
  await p.route('**' + broken, route => route.fulfill({ contentType: 'image/png', body: 'invalid synthetic PNG' }));
  await p.locator('#standaloneAvatar img').evaluate((img, source) => { img.dataset.sharedSrc = source; }, broken);
  await p.waitForFunction(() => document.querySelector('#standaloneAvatar img').dataset.sharedState === 'failed');
  const fallback = p.locator('#standaloneAvatar .persona-avatar-initial');
  assert.equal(await fallback.textContent(), '아');
  assert.equal(await fallback.isVisible(), true);
  assert.equal(await fallback.evaluate(node => getComputedStyle(node).display), 'grid');
  assert.equal(await fallback.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(238, 241, 246)');
  assert.deepEqual(await fallback.evaluate(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; }), [40, 40]);
  assert.equal(await p.locator('#standaloneAvatar img').evaluate(img => getComputedStyle(img).visibility), 'hidden');
  assert.equal(await p.locator('#standaloneAvatar').getAttribute('aria-label'), '아디나');
  assert.deepEqual(f.errors, []);
});

test('world renders public portraits, former-member history and furniture with live updates', worldOptions, async (t) => {
  const f = await fixture(t, { pathname: '/world.html' }), p = f.page;
  await p.waitForFunction(() => window.__worldRenderStats?.().blocks === 6
    && [...document.querySelectorAll('#who img')].length === 4
    && [...document.querySelectorAll('#who img')].every((img) => img.complete && img.naturalWidth > 0));
  assert.deepEqual(await p.locator('#who button').evaluateAll((nodes) => nodes.map((node) => node.dataset.id)), ['eleven', 'adina', 'lucia', 'bianca']);
  assert.equal(await p.locator('#scene canvas').count(), 1);
  const stats = await p.evaluate(() => window.__worldRenderStats());
  assert.equal(stats.batches, 6, 'five furniture shapes and a lamp remain rendered');
  assert.ok(stats.calls > 0 && stats.triangles > 0);
  await p.locator('#who button[data-id="adina"]').click();
  assert.equal(await p.locator('#who button.on').getAttribute('data-id'), 'adina');
  f.emit('avatars', { eleven: { x: 14, y: 1, z: 16, posture: 'sit', facing: 's' } });
  f.emit('members', f.members.map((m) => m.id === 'bianca' ? { ...m, accentColor: '#ffe066' } : m));
  await p.waitForFunction(() => document.querySelector('#who [data-id="bianca"] .persona-avatar').style.outline.includes('255, 224, 102'));
  f.emit('msg', { id: 3, from: 'former-member', text: '월드의 이전 대화' });
  await p.waitForFunction(() => document.querySelector('#chat').textContent.includes('월드의 이전 대화'));
  assert.match(await p.locator('#chat').textContent(), /이전 멤버/);
  assert.doesNotMatch(f.payloads.join('\n'), privateIdentity);
  assert.doesNotMatch(f.requests.join('\n'), /\/avatars\/|\/assets\/characters\/(?:claude|gpt|deepseek|gemini|grok)\//);
  assert.deepEqual(f.errors, []);
});

test('/admin login, public SSE merging, admin updates and logout preserve the role boundary', browserOptions, async (t) => {
  const f = await fixture(t, { pathname: '/admin' }), p = f.page;
  await p.waitForSelector('#loginDialog[open]');
  await p.locator('#adminPassword').fill('wrong'); await p.locator('#loginSubmit').click();
  await p.waitForSelector('#loginError:not([hidden])');
  assert.match(await p.locator('#loginError').textContent(), /확인해 주세요/);
  assert.equal(await p.locator('#adminPassword').inputValue(), '');
  await login(p);
  assert.equal(await p.locator('#speed .on').getAttribute('data-v'), 'slow');
  assert.equal(await p.locator('#autosleep').inputValue(), '60');
  assert.equal(await p.locator('#boostMode .on').getAttribute('data-v'), 'manual');
  assert.equal(await p.locator('.settings').isVisible(), true);
  assert.equal(await p.locator('#meTag').isVisible(), true);
  assert.equal(await p.locator('.switch').count(), 4);
  for (const [i, id] of ['eleven', 'adina', 'lucia', 'bianca'].entries()) {
    const posted = p.waitForResponse((res) => res.url().endsWith('/api/member'));
    await p.locator('.switch input').nth(i).uncheck();
    await posted;
    assert.deepEqual(f.calls.at(-1), { path: '/api/member', body: { id, enabled: false } });
  }
  assert.equal(await p.locator('#m1 .reacts .chip').isEnabled(), true);
  assert.equal(await p.locator('#input').isEditable(), true);
  assert.equal(await p.locator('#stat').isVisible(), false);
  assert.equal(await p.locator('#wsUsage').isVisible(), false);
  f.emit('room', { running: true, sleeping: false, dev: { online: true } });
  await p.waitForSelector('#app.running');
  assert.equal(await p.locator('#speed .on').getAttribute('data-v'), 'slow');
  assert.equal(await p.locator('#autosleep').inputValue(), '60');
  assert.equal(await p.locator('#boostMode .on').getAttribute('data-v'), 'manual');
  await p.locator('#speed [data-v="fast"]').click();
  await p.waitForSelector('#speed [data-v="fast"].on');
  assert.equal(f.calls.at(-1).path, '/api/room');
  assert.deepEqual(f.calls.at(-1).body, { speed: 'fast' });
  assert.equal(await p.evaluate(() => document.cookie), '');
  assert.doesNotMatch(await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }) + location.href), /fixture-secret|fixture=admin/);
  await p.locator('#input').fill('unsent private draft');
  await p.locator('#adminLogout').click();
  await p.waitForFunction(() => document.body.dataset.role === 'viewer');
  assert.equal(await p.locator('#input').inputValue(), '');
  assert.equal(await p.locator('#power').isDisabled(), true);
  assert.equal(await p.locator('.settings').isVisible(), false);
  assert.equal(await p.locator('#meTag').isVisible(), false);
  assert.equal(await p.locator('.tools:visible').count(), 0);
  assert.equal(await p.locator('.reacts:visible').count(), 2);
  assert.equal(await p.locator('#m1 .reacts .chip').isDisabled(), true);
  assert.equal(await p.locator('.switch').count(), 0);
  assert.doesNotMatch(f.payloads.join('\n'), privateIdentity, 'admin HTTP and SSE keep the public identity contract');
  assert.deepEqual(f.errors, []);
});

test('neutral sticker aliases remain selectable and unavailable files do not request unsafe content', browserOptions, async (t) => {
  const f = await fixture(t, { admin: true }), p = f.page;
  await p.waitForFunction(() => document.body.dataset.role === 'admin');
  const sticker = { path: 'private-files/ERCraft-123.png', sticker: true, stickerOwner: 'eleven', by: 'adina', available: true, size: 68, mtime: 1700000000000 };
  f.emit('ws', [sticker, { path: 'unavailable.svg', available: false, unavailable: '공개 사본을 제공할 수 없습니다.', mtime: 1700000000000 }]);
  await p.waitForFunction(() => document.querySelector('#wsFiles').textContent.includes('unavailable.svg'));
  await p.locator('#stickerBtn').click();
  await p.waitForSelector('.sticker-item');
  assert.equal(await p.locator('.sticker-head').textContent(), '일레븐');
  const sent = p.waitForResponse(r => r.url().endsWith('/api/send'));
  await p.locator('.sticker-item').click(); await sent;
  assert.deepEqual(f.calls.at(-1).body, { sticker: sticker.path });
  await p.locator('.file').filter({hasText:'unavailable.svg'}).click();
  await p.waitForSelector('.viewer-body .ws-empty');
  assert.equal(await p.locator('.viewer-body').textContent(), '공개 사본을 제공할 수 없습니다.');
  assert.equal(await p.locator('.viewer-head a').count(), 0);
  assert.ok(!f.requests.some(url => /\/ws\/unavailable\.svg|\/api\/file\?path=unavailable/.test(url)));
  assert.deepEqual(f.errors, []);
});

test('expiry closes compose actions immediately and rejects a delayed stale admin state response', browserOptions, async (t) => {
  const f = await fixture(t, { admin: true }), p = f.page;
  await p.waitForFunction(() => document.body.dataset.role === 'admin');
  await p.locator('#input').fill('draft before expiry');
  f.holdNextState();
  f.emit('session', { role: 'viewer', authenticated: false });
  await p.waitForFunction(() => document.body.dataset.role === 'viewer');
  // Give the first refetch enough event-loop turns to reach the local fixture.
  for (let i = 0; i < 50 && !f.stateHeld(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.stateHeld(), true);
  f.expire();
  f.emit('session', { role: 'viewer', authenticated: false });
  await p.waitForFunction(() => document.body.dataset.role === 'viewer' && document.querySelector('#input').value === '');
  const delivered = p.waitForResponse((res) => res.url().endsWith('/api/state'));
  f.releaseState();
  await delivered;
  assert.equal(await p.locator('#power').isDisabled(), true);
  assert.equal(await p.locator('#input').isEditable(), false);
  assert.equal(await p.locator('.settings').isVisible(), false);
  assert.equal(await p.locator('#meTag').isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test('initial authenticated /admin SSE does not open login or clear an existing admin draft', browserOptions, async (t) => {
  const f = await fixture(t, { admin: true, pathname: '/admin' }), p = f.page;
  await p.waitForFunction(() => document.body.dataset.role === 'admin');
  assert.equal(await p.locator('#loginDialog').isVisible(), false);
  await p.locator('#input').fill('keep this admin draft');
  f.emit('session', { role: 'admin', authenticated: true });
  f.emit('room', { running: true });
  await p.waitForSelector('#app.running');
  assert.equal(await p.locator('#input').inputValue(), 'keep this admin draft');
  assert.equal(await p.locator('#loginDialog').isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test('mobile viewer keeps navigation and login readable without horizontal overflow', browserOptions, async (t) => {
  const { page, errors } = await fixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#openSide').click();
  await page.locator('#adminLogin').click();
  assert.equal(await page.locator('#loginDialog').isVisible(), true);
  const bounds = await page.locator('#loginDialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#loginDialog').isVisible(), false);
  assert.deepEqual(errors, []);
});
