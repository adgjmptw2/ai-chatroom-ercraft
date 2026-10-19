// Actual world UI + synthetic loopback APIs/SSE. No running service, room data,
// providers, external assets or game actions are used by this fixture.
// CHATROOM_THREE_ROOT=/installed/three node --test tests/living-view-browser.test.mjs
// LIVING_SCREENSHOT_DIR=/temporary/output optionally saves desktop/mobile/SHOT evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import { buildHouse } from '../lib/house.mjs';
import { SIZE, PALETTE } from '../lib/world.mjs';

const root = path.resolve(import.meta.dirname, '../public'), base = '/chat';
const threeRoot = process.env.CHATROOM_THREE_ROOT, out = process.env.LIVING_SCREENSHOT_DIR;
const require = createRequire(import.meta.url);
let chromium;
for (const name of [process.env.CHATROOM_PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { ({ chromium } = require(name)); break; } catch { /* use an installed runtime */ }
}
const executablePath = process.env.CHATROOM_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const options = { timeout: 60000, skip: (!chromium || !threeRoot) && 'Set CHATROOM_THREE_ROOT and use an installed Playwright/Chrome' };
const members = [
  { id: 'adina', name: '아디나', color: '#719c8b' }, { id: 'eleven', name: '일레븐', color: '#c28091' },
  { id: 'bianca', name: '비앙카', color: '#c49b49' }, { id: 'lucia', name: '루치아', color: '#9a8db8' },
];
const lifestyle = (revision = 1) => ({ revision, tableSet: true, blankets: [
  { spot: 'sofa-1', style: 'mint', owner: 'adina' }, { spot: 'sofa-4', style: 'butter', owner: 'bianca' },
  { spot: 'eleven-bed', style: 'pink', owner: 'eleven' }, { spot: 'lucia-bed', style: 'lavender', owner: 'lucia' },
] });
function screenshotBudget() {
  if (!out) return;
  // No downloads/builds. Reserve 50 MiB for this fixture's PNGs and metrics.
  const disk = fs.statfsSync(path.parse(path.resolve(out)).root);
  assert.ok(disk.bavail * disk.bsize >= 15 * 1024 ** 3 + 50 * 1024 ** 2, '15 GiB free plus screenshot budget required');
}
function snapshot(revision = 1) {
  return { version: 1, revision, pausedAt: null,
    meal: { id: 'synthetic-meal', revision, recipe: 'soup', label: '따뜻한 수프', status: 'cooking', cook: 'adina',
      readyAt: 1790870000000, servings: 4, remaining: 4, eatenBy: [] },
    game: { id: 'synthetic-game', revision, kind: 'tic-tac-toe', status: 'playing', players: ['adina', 'eleven'],
      board: ['X', null, null, null, 'O', null, null, null, null], turn: 'adina', winner: null, result: null,
      winningCells: [], expiresAt: 1790870200000 },
    events: [{ id: 'synthetic-event', at: 1790870000000, text: '아디나가 주방에서 수프를 준비해요.' }] };
}
// Serialized into the fixture's world module only. Probe actual visible geometry
// above the tabletop, so static duplicate dishes cannot hide behind correct stats.
function inspectDiningSettings() {
  scene.updateMatrixWorld(true);
  const targets = [];
  scene.traverse(o => {
    if (o.isInstancedMesh) o.computeBoundingSphere();
    if (o.isMesh) targets.push(o);
  });
  const ray = new THREE.Raycaster(); ray.far = .48;
  const occupied = (x, z) => {
    ray.set(new THREE.Vector3(x, 4.5, z), new THREE.Vector3(0, -1, 0));
    return ray.intersectObjects(targets, false).some(hit => {
      for (let o = hit.object; o; o = o.parent) if (!o.visible) return false;
      return true;
    });
  };
  let plates = 0, cups = 0;
  for (const x of [25.58, 27.42]) for (const z of [32.48, 33.52]) {
    if (occupied(x, z)) plates++;
    if (occupied(x + (x < 26.5 ? .27 : -.27), z)) cups++;
  }
  return { plates, cups };
}
async function fixture(t, { failure = false } = {}) {
  const house = buildHouse();
  const world = { ...house, size: SIZE, palette: Object.fromEntries(Object.entries(PALETTE).map(([key, value]) => [key, value[1]])),
    blocks: Object.entries(house.blocks).map(([key, value]) => [...key.split(',').map(Number), value]),
    // Synthetic members stand clear of furniture so closeups show the props.
    avatars: { adina: { x: 31, y: 4, z: 35 }, eleven: { x: 20, y: 4, z: 31 }, bianca: { x: 20, y: 4, z: 32 }, lucia: { x: 20, y: 4, z: 34 } } };
  const state = { room: { running: false, sleeping: true, userName: '합성 관전 fixture' }, members,
    files: [], messages: members.map(m => ({ from: m.id, text: '집에서 함께 쉬며 식사와 보드게임을 기다리고 있어요.' })) };
  const data = { living: snapshot(), failure };
  const clients = new Set(), requests = [], errors = [], unexpected = [];
  const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push({ method: req.method, path: url.pathname });
    if (req.method === 'GET' && url.pathname === '/ercraft-symbol.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(path.join(root, 'ercraft-symbol.png')));
    }
    if (req.method !== 'GET' || !url.pathname.startsWith(base + '/')) { unexpected.push(req.url); return json(res, {}, 404); }
    const route = url.pathname.slice(base.length);
    if (/^\/assets\/characters\/(?:eleven|adina|lucia|bianca|dev)\/(?:avatar|full)\.png$/.test(route)) {
      // Artwork is optional in the published checkout; known missing public
      // portraits must use the UI fallback without permitting other paths.
      return json(res, {}, 404);
    }
    if (route === '/api/living') return data.failure ? json(res, { error: 'fixture unavailable' }, 503) : json(res, data.living);
    if (route === '/api/state') return json(res, state);
    if (route === '/api/world') return json(res, world);
    if (route === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write('retry: 150\n: synthetic living fixture\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    const file = path.resolve(root, '.' + route);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { unexpected.push(req.url); return json(res, {}, 404); }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) body = body.toString().replace('<head>', `<head><meta name="chatroom-base" content="${base}">`)
      .replace('window.__worldRenderStats =', `window.__fixtureDiningSettings = ${inspectDiningSettings.toString()};\nwindow.__worldRenderStats =`);
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const c of clients) c.end(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = route.request().url(), prefix = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';
    if (url.startsWith(prefix)) {
      const file = path.resolve(threeRoot, url.slice(prefix.length));
      if (file.startsWith(path.resolve(threeRoot) + path.sep) && fs.existsSync(file)) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(file) });
    }
    // The world stylesheet is optional. No external font/image fetch occurs.
    if (url.includes('pretendardvariable-dynamic-subset.min.css')) return route.fulfill({ contentType: 'text/css', body: '' });
    if (new URL(url).origin === origin) return route.continue();
    unexpected.push(url); return route.abort();
  });
  async function pageAt(query = '', viewport) {
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    if (viewport) await page.setViewportSize(viewport);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}${base}/world.html${query}`);
    await page.waitForFunction(() => window.__worldRenderStats?.().style === 'diorama');
    return page;
  }
  function emit(type, value) { for (const client of clients) client.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`); }
  function living(value) { data.living = value; emit('living', value); }
  async function capture(page, name) {
    if (!out) return; screenshotBudget(); fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, name + '.png') });
  }
  t.after(() => {
    assert.deepEqual(errors, [], 'no browser errors'); assert.deepEqual(unexpected, [], 'all traffic stays in the isolated fixture');
    assert.ok(requests.every(r => r.method === 'GET'), 'spectating never submits a game/meal action');
  });
  return { page: await pageAt(), pageAt, data, requests, clients, emit, living, capture, errors };
}
const stats = page => page.evaluate(() => window.__worldRenderStats());
const diningSettings = page => page.evaluate(() => window.__fixtureDiningSettings());
async function revision(page, value) { await page.waitForFunction(r => window.__worldRenderStats().living.revision === r, value); }
async function assertNoOverlap(page) {
  const layout = await page.evaluate(() => {
    const p = document.querySelector('#living-panel').getBoundingClientRect(), top = document.querySelector('.top').getBoundingClientRect(), chat = document.querySelector('#chat').getBoundingClientRect();
    return { toolbarClear: p.top >= top.bottom, chatClear: p.bottom <= chat.top || p.left >= chat.right,
      viewportClear: p.right <= innerWidth && p.bottom <= innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.deepEqual(layout, { toolbarClear: true, chatClear: true, viewportClear: true, overflow: false });
}

test('world spectator replays kitchen, meals and winning board with idle budget, mobile and SHOT evidence', options, async t => {
  const f = await fixture(t), { page } = f;
  await revision(page, 1); await page.locator('[data-camera="living"]').click(); await page.waitForTimeout(350);
  assert.match(await page.locator('.living-meal').textContent(), /준비 중/);
  assert.match(await page.locator('.living-game-status').textContent(), /아디나 차례/);
  assert.equal((await stats(page)).living.cooking, true);
  await f.capture(page, 'desktop-cooking');
  const ready = snapshot(2); ready.meal.status = 'ready'; f.living(ready); await revision(page, 2);
  assert.match(await page.locator('.living-meal').textContent(), /준비 완료/);
  assert.equal((await stats(page)).living.food, 0);
  assert.equal((await stats(page)).living.plates, 0);
  assert.equal((await stats(page)).living.cooking, true);
  const win = snapshot(3); win.meal.status = 'served'; win.meal.remaining = 3; win.meal.eatenBy = ['eleven'];
  Object.assign(win.game, { status: 'finished', board: ['X', 'X', 'X', 'O', 'O', null, null, null, null], turn: null, winner: 'adina', result: 'win', winningCells: [0, 1, 2] });
  win.events.push({ id: 'win', at: 1790870000010, text: '아디나가 한 줄을 완성했어요. 일레븐은 수프 한 그릇을 먹었어요.' });
  f.living(win); await revision(page, 3); await page.waitForTimeout(350);
  assert.equal((await stats(page)).living.food, 3);
  assert.equal((await stats(page)).living.cooking, false);
  assert.match(await page.locator('.living-eaters').textContent(), /일레븐/);
  assert.equal(await page.locator('.living-game-status').textContent(), '아디나 승리');
  assert.equal(await page.locator('.living-board td.winning').count(), 3);
  assert.equal(await page.locator('.living-board td').count(), 9);
  assert.equal(await page.locator('.living-board').getAttribute('aria-readonly'), 'true');
  assert.equal(await page.locator('#living-view button, #living-view a, #living-view input, #living-view form').count(), 0);
  await page.locator('.living-board td').first().click(); assert.equal((await stats(page)).living.revision, 3);
  await assertNoOverlap(page); await f.capture(page, 'desktop-meal-win');
  const settled = await stats(page), livingRequests = f.requests.filter(r => r.path.endsWith('/api/living')).length;
  for (let i = 0; i < 12; i++) f.emit('living', win);
  f.emit('living', snapshot(1)); await page.waitForTimeout(800);
  const idle = await stats(page);
  assert.equal(idle.renderedFrames, settled.renderedFrames, 'duplicate/old SSE and idle time cause zero draws');
  assert.equal(f.requests.filter(r => r.path.endsWith('/api/living')).length, livingRequests, 'no polling');
  assert.equal(idle.maxFps, 30); assert.equal(idle.passes, 1); assert.equal(idle.lights, 2);
  assert.equal(idle.living.meshes, 12); assert.equal(idle.living.geometries, 5);
  assert.ok(idle.calls < 100); assert.ok(idle.triangles < 100000);
  const mobile = await f.pageAt('', { width: 390, height: 844 }); await revision(mobile, 3);
  assert.equal(await mobile.locator('#living-panel').evaluate(el => el.open), false);
  await f.capture(mobile, 'mobile-collapsed');
  await mobile.locator('#living-panel summary').click(); await mobile.waitForTimeout(200);
  await assertNoOverlap(mobile); await f.capture(mobile, 'mobile-meal-win');
  await mobile.setViewportSize({ width: 360, height: 640 }); await mobile.waitForTimeout(200); await assertNoOverlap(mobile);
  await f.capture(mobile, 'mobile-small'); await mobile.close();
  const shot = await f.pageAt('?shot=1&tx=23&tz=33&dist=24&elev=52&angle=0');
  await shot.waitForFunction(() => window.__shotReady === true);
  assert.equal(await shot.locator('#living-panel').isVisible(), false);
  assert.equal((await stats(shot)).living.board, true); assert.equal((await stats(shot)).living.plates, 4);
  await f.capture(shot, 'shot-props'); await shot.close();

  const paused = structuredClone(win); paused.revision = 4; paused.pausedAt = 1790870000500;
  paused.game.result = 'expired'; paused.game.winner = null; paused.game.winningCells = [];
  f.living(paused); await revision(page, 4);
  assert.match(await page.locator('.living-notice').textContent(), /일시 정지/);
  assert.equal(await page.locator('.living-game-status').textContent(), '시간 만료');
  const renamed = members.map(m => ({ ...m, name: m.id === 'adina' ? '새 이름' : m.name })); f.emit('members', renamed);
  await page.waitForFunction(() => document.querySelector('.living-meal').textContent.includes('새 이름'));

  // Labels, public names and event text stay literal; URLs never become links.
  const hostile = snapshot(5); hostile.meal.label = '<img src=x onerror="window.__livingXss=1">';
  hostile.events = Array.from({ length: 10 }, (_, i) => ({ id: String(i), at: i, text: `<svg onload="window.__livingXss=2"> ${i} https://example.invalid/` }));
  f.living(hostile); f.emit('members', members.map(m => ({ ...m, name: '<a href="javascript:alert(1)">이름</a>' })));
  await revision(page, 5);
  assert.equal(await page.locator('#living-view img, #living-view svg, #living-view a, #living-view script').count(), 0);
  assert.equal(await page.locator('.living-events li').count(), 8);
  assert.equal(await page.evaluate(() => window.__livingXss), undefined);
  assert.match(await page.locator('.living-meal').textContent(), /<img src=x/);

  // Closing this synthetic SSE causes exactly a reconnect GET. A lower revision
  // is accepted as the new authoritative lifetime, while camera choice survives.
  f.data.living = { version: 1, revision: 0, pausedAt: null, meal: null, game: null, events: [] };
  for (const client of f.clients) client.end(); await revision(page, 0);
  assert.equal((await stats(page)).camera, 'living');
  assert.equal((await stats(page)).living.visibleMeshes, 0);
  assert.match(await page.locator('.living-meal').textContent(), /지금 준비된 식사가 없어요/);
  await page.waitForTimeout(200); const withoutProps = await stats(page);
  if (out) fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify({ synthetic: true, productionRequests: 0,
    initial: settled, idleExtraFrames: idle.renderedFrames - settled.renderedFrames,
    withoutProps: { calls: withoutProps.calls, triangles: withoutProps.triangles },
    propOverhead: { calls: settled.calls - withoutProps.calls, triangles: settled.triangles - withoutProps.triangles },
    noPolling: true, mobileNoOverlap: true, shotPropsVisible: true, errors: f.errors,
    livingGetRequests: f.requests.filter(r => r.path.endsWith('/api/living')).length }, null, 2));
});

test('lifestyle table, pleated dumplings, cookies, fruit and anchored throws stay bounded and idle', options, async t => {
  const f = await fixture(t), { page } = f; await revision(page, 1);
  assert.equal((await stats(page)).living.propsRevision, 0);
  assert.equal((await stats(page)).living.cups, 0);
  assert.deepEqual(await diningSettings(page), { plates: 0, cups: 0 }, 'unprepared table has no static dishes');
  assert.match(await page.locator('.living-lifestyle').textContent(), /생활 소품.*상차림 전.*담요 0\/4개/);
  const prepared = snapshot(2); prepared.meal = null; prepared.props = lifestyle(1);
  f.living(prepared); await revision(page, 2); await page.locator('[data-camera="living"]').click();
  await page.waitForTimeout(250);
  let current = await stats(page);
  assert.equal(current.living.plates, 4); assert.equal(current.living.foodInstances, 0);
  assert.equal(current.living.cups, 4);
  assert.deepEqual(await diningSettings(page), { plates: 4, cups: 4 });
  assert.equal(current.living.blankets, 4); assert.equal(current.living.propsRevision, 1);
  const propText = await page.locator('.living-lifestyle').textContent();
  for (const value of ['생활 소품', '상차림 완료', '담요 4/4개', '거실 소파 1번', '거실 소파 4번', '일레븐 침대', '루치아 침대', '민트', '버터', '핑크', '라벤더']) {
    assert.ok(propText.includes(value), value);
  }
  assert.doesNotMatch(propText, /gpt|claude|gemini|deepseek|sofa-|eleven-bed|lucia-bed/i);
  await assertNoOverlap(page); await f.capture(page, 'lifestyle-table-set');
  const tableQuery = '?shot=1&cx=28&cy=7.6&cz=37&lx=26&ly=4.6&lz=32.5';
  const tableMeasurements = [];
  for (const [device, viewport, fov] of [['desktop', { width: 1440, height: 960 }, 34], ['mobile', { width: 390, height: 844 }, 62]]) {
    const table = await f.pageAt(`${tableQuery}&fov=${fov}`, viewport);
    await table.waitForFunction(() => window.__shotReady === true);
    const measured = await stats(table);
    assert.equal(measured.living.plates, 4); assert.equal(measured.living.cups, 4); assert.equal(measured.living.foodInstances, 0);
    assert.deepEqual(await diningSettings(table), { plates: 4, cups: 4 });
    assert.ok(measured.calls < 100);
    tableMeasurements.push({ device, calls: measured.calls, triangles: measured.triangles, food: measured.living.food });
    await f.capture(table, `table-set-plates-${device}`); await table.close();
  }
  const desktopActors = current.actors;
  const measurements = []; let serial = 2;
  for (const [recipe, label] of [['dumplings', '만두'], ['cookies', '쿠키'], ['fruit', '과일'], ['burger', '버거']]) {
    const ready = snapshot(++serial); ready.props = lifestyle(1); ready.meal.recipe = recipe;
    delete ready.meal.label; ready.meal.status = 'ready';
    f.living(ready); await revision(page, serial);
    assert.equal((await stats(page)).living.foodInstances, 0);
    assert.equal((await stats(page)).living.plates, 4);
    assert.equal((await stats(page)).living.cups, 4);
    assert.match(await page.locator('.living-meal-title').textContent(), new RegExp(`${label} · 준비 완료`));
    const served = structuredClone(ready); served.revision = ++serial; served.meal.status = 'served';
    f.living(served); await revision(page, serial);
    // SHOT is deliberately a one-shot GET with no SSE subscription.
    const mealView = await f.pageAt(`${tableQuery}&fov=34`);
    await mealView.waitForFunction(() => window.__shotReady === true); await revision(mealView, serial);
    await page.waitForTimeout(220);
    const rendered = await stats(page), closeup = await stats(mealView);
    assert.equal(rendered.living.food, 4); assert.equal(rendered.living.blankets, 4); assert.equal(rendered.living.cups, 4);
    assert.equal(rendered.living.propsRevision, 1, 'meal updates do not change scoped props revision');
    assert.deepEqual(rendered.actors, desktopActors, 'props never move actors or change posture');
    for (const measured of [rendered, closeup]) {
      assert.equal(measured.living.meshes, 12); assert.equal(measured.living.geometries, 5);
      assert.equal(measured.living.materials, 6); assert.ok(measured.calls < 100, `${recipe}: ${measured.calls} calls`);
      assert.ok(measured.triangles < 100000);
    }
    const beforeRequests = f.requests.length;
    for (let n = 0; n < 8; n++) f.emit('living', served);
    f.emit('living', prepared); await page.waitForTimeout(450);
    const idle = await stats(page);
    assert.equal(idle.renderedFrames, rendered.renderedFrames, `${recipe}: no idle or replay frames`);
    assert.equal((await stats(mealView)).renderedFrames, closeup.renderedFrames);
    assert.equal(f.requests.length, beforeRequests, 'recipe replay does not poll or load assets');
    measurements.push({ recipe, calls: rendered.calls, closeupCalls: closeup.calls, triangles: rendered.triangles,
      living: rendered.living, idleExtraFrames: idle.renderedFrames - rendered.renderedFrames });
    await f.capture(mealView, `food-${recipe}`); await mealView.close();
    if (recipe !== 'burger') {
      const mobileFood = await f.pageAt(`${tableQuery}&fov=62`, { width: 390, height: 844 });
      await mobileFood.waitForFunction(() => window.__shotReady === true);
      const measured = await stats(mobileFood);
      assert.equal(measured.living.food, 4); assert.equal(measured.living.blankets, 4);
      assert.ok(measured.calls < 100); assert.ok(measured.triangles < 100000);
      await mobileFood.waitForTimeout(200);
      assert.equal((await stats(mobileFood)).renderedFrames, measured.renderedFrames, 'mobile closeup also stays idle');
      measurements.at(-1).mobile = { calls: measured.calls, triangles: measured.triangles, idleExtraFrames: 0 };
      await f.capture(mobileFood, `mobile-food-${recipe}`); await mobileFood.close();
    }
    served.revision = ++serial; served.meal.remaining = 1; f.living(served); await revision(page, serial);
    assert.equal((await stats(page)).living.food, 1);
    served.revision = ++serial; served.meal.status = 'finished'; served.meal.remaining = 0;
    f.living(served); await revision(page, serial);
    assert.equal((await stats(page)).living.foodInstances, 0);
    assert.equal((await stats(page)).living.cups, 4, 'finished meals retain their setting until cleared');
  }
  // The renderer has now seen every geometry. Recipe/style churn must not grow
  // GPU geometry or texture memory, even when every blanket moves to a new spot.
  const warmed = await stats(page);
  for (let i = 0; i < 21; i++) {
    const replay = snapshot(++serial); replay.props = lifestyle(2);
    replay.meal.recipe = ['soup', 'dumplings', 'cookies', 'fruit', 'burger', 'toast', 'tea'][i % 7];
    replay.meal.status = 'served'; replay.meal.remaining = i % 4 + 1;
    replay.props.blankets.forEach((b, j) => {
      b.spot = i % 2 ? `sofa-${j + 1}` : `${members[j].id}-bed`;
      b.style = ['mint', 'butter', 'pink', 'lavender'][(i + j) % 4];
    });
    f.living(replay); await revision(page, serial);
  }
  await page.waitForTimeout(150);
  const replayed = await stats(page);
  assert.equal(replayed.geometries, warmed.geometries, 'GPU geometry count stays flat after warmup');
  assert.equal(replayed.textures, warmed.textures, 'lifestyle props never create textures');
  const cozy = snapshot(++serial); cozy.meal = null; cozy.props = lifestyle(2);
  cozy.props.blankets = members.map((m, i) => ({ spot: `sofa-${i + 1}`, style: ['mint', 'butter', 'pink', 'lavender'][i], owner: m.id }));
  f.living(cozy); await revision(page, serial);
  const sofa = await f.pageAt('?shot=1&cx=14&cy=7&cz=37&lx=10&ly=4.3&lz=33.5&fov=42');
  await sofa.waitForFunction(() => window.__shotReady === true);
  assert.equal((await stats(sofa)).living.blankets, 4); await f.capture(sofa, 'blankets-sofa'); await sofa.close();
  const mobileSofa = await f.pageAt('?shot=1&cx=14&cy=7&cz=37&lx=10&ly=4.3&lz=33.5&fov=65', { width: 390, height: 844 });
  await mobileSofa.waitForFunction(() => window.__shotReady === true);
  assert.equal((await stats(mobileSofa)).living.blankets, 4); assert.ok((await stats(mobileSofa)).calls < 100);
  await f.capture(mobileSofa, 'mobile-blankets-sofa'); await mobileSofa.close();
  cozy.revision = ++serial; cozy.props.revision++;
  cozy.props.blankets = members.map((m, i) => ({ spot: `${m.id}-bed`, style: ['mint', 'butter', 'pink', 'lavender'][i], owner: m.id }));
  f.living(cozy); await revision(page, serial);
  const bed = await f.pageAt('?shot=1&cx=13&cy=6.6&cz=15&lx=11&ly=4&lz=11&fov=38');
  await bed.waitForFunction(() => window.__shotReady === true);
  assert.equal((await stats(bed)).living.blankets, 4); await f.capture(bed, 'blankets-bed'); await bed.close();
  const mobileBed = await f.pageAt('?shot=1&cx=13&cy=6.6&cz=15&lx=11&ly=4&lz=11&fov=60', { width: 390, height: 844 });
  await mobileBed.waitForFunction(() => window.__shotReady === true);
  assert.equal((await stats(mobileBed)).living.blankets, 4); assert.ok((await stats(mobileBed)).calls < 100);
  await f.capture(mobileBed, 'mobile-blankets-bed'); await mobileBed.close();
  const mobile = await f.pageAt('', { width: 360, height: 640 }); await revision(mobile, serial);
  await mobile.locator('#living-panel summary').click(); await mobile.waitForTimeout(200);
  await assertNoOverlap(mobile); await f.capture(mobile, 'mobile-lifestyle');
  await mobile.locator('.living-blanket-list').scrollIntoViewIfNeeded();
  await assertNoOverlap(mobile); await f.capture(mobile, 'mobile-lifestyle-blankets'); await mobile.close();
  // A props-only revision can change with unchanged meal/game scopes.
  cozy.revision = ++serial; cozy.props = { revision: 4, tableSet: false, blankets: [] }; cozy.game = null;
  f.living(cozy); await revision(page, serial);
  assert.equal((await stats(page)).living.visibleMeshes, 0);
  assert.equal((await stats(page)).living.cups, 0);
  assert.deepEqual(await diningSettings(page), { plates: 0, cups: 0 }, 'table_clear visibly clears both dynamic and static dishes');
  assert.match(await page.locator('.living-lifestyle').textContent(), /상차림 전.*담요 0\/4개/);
  assert.equal(await page.locator('.living-blanket-list').count(), 0);
  await page.waitForTimeout(180);
  const withoutProps = await stats(page);
  for (const measured of measurements) {
    measured.propOverhead = { calls: measured.calls - withoutProps.calls, triangles: measured.triangles - withoutProps.triangles };
    assert.equal(measured.propOverhead.calls, measured.living.visibleMeshes, 'each visible prop batch costs exactly one call');
  }
  for (const [device, viewport, fov] of [['desktop', { width: 1440, height: 960 }, 34], ['mobile', { width: 390, height: 844 }, 62]]) {
    const cleared = await f.pageAt(`${tableQuery}&fov=${fov}`, viewport);
    await cleared.waitForFunction(() => window.__shotReady === true);
    assert.deepEqual(await diningSettings(cleared), { plates: 0, cups: 0 });
    assert.equal((await stats(cleared)).living.foodInstances, 0);
    await f.capture(cleared, `table-cleared-${device}`); await cleared.close();
  }
  if (out) {
    screenshotBudget();
    fs.writeFileSync(path.join(out, 'lifestyle-metrics.json'), JSON.stringify({ synthetic: true, productionRequests: 0,
      measurements, tableMeasurements, withoutProps: { calls: withoutProps.calls, triangles: withoutProps.triangles },
      stableGpuGeometries: replayed.geometries, stableTextures: replayed.textures,
      clearedVisibleDishes: await diningSettings(page),
      privateIdsVisible: false, actorChanges: false, noPolling: true, errors: f.errors }, null, 2));
  }
});

test('failed GET is unknown, recovers through SSE, and failed reconnect retains explicitly stale state', options, async t => {
  const f = await fixture(t, { failure: true }), { page } = f;
  assert.equal(await page.locator('#living-view').getAttribute('data-connection'), 'unknown');
  assert.match(await page.locator('.living-notice').textContent(), /상태 확인 불가/);
  assert.match(await page.locator('.living-meal').textContent(), /상태 확인 전/);
  assert.doesNotMatch(await page.locator('.living-meal').textContent(), /식사가 없어요/);
  f.living(snapshot(6)); await revision(page, 6);
  assert.equal(await page.locator('#living-view').getAttribute('data-connection'), 'live');
  await page.waitForTimeout(200);
  const known = await stats(page), mealText = await page.locator('.living-meal').textContent();
  f.emit('living', { unavailable: true });
  await page.waitForFunction(() => document.querySelector('#living-view').dataset.connection === 'unknown');
  assert.match(await page.locator('.living-notice').textContent(), /생활 상태 확인 불가.*마지막으로 받은 상태/);
  assert.equal(await page.locator('.living-meal').textContent(), mealText);
  assert.deepEqual((await stats(page)).living, known.living);
  assert.equal((await stats(page)).renderedFrames, known.renderedFrames, 'unavailable only updates the notice');
  f.emit('living', snapshot(5)); await page.waitForTimeout(50);
  assert.equal(await page.locator('#living-view').getAttribute('data-connection'), 'unknown', 'old revision cannot clear the warning');
  f.emit('living', snapshot(6));
  await page.waitForFunction(() => document.querySelector('#living-view').dataset.connection === 'live');
  for (const client of f.clients) client.end();
  await page.waitForFunction(() => document.querySelector('#living-view').dataset.connection === 'unknown');
  assert.equal((await stats(page)).living.revision, 6);
  assert.match(await page.locator('.living-notice').textContent(), /마지막으로 받은 상태/);
  f.living(snapshot(6)); await page.waitForFunction(() => document.querySelector('#living-view').dataset.connection === 'live');
});
