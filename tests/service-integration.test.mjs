// Actual server process + real loopback sockets. Never uses a live room/provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { serviceFixture, pause } from './helpers/service-fixture.mjs';

const PRIVATE_KEY = /^(?:usage|quotas?|batteries|remainingPct|usedPercent|resetsAt|windows|account|plan|tokens|models?|defaultModel|boostModel|imageModel|provider|maker|imageVision|calls|calls30|lastMs|lastError)$/i;
function publicOnly(value, at = 'public') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, PRIVATE_KEY, `${at}.${key} leaks private metadata`);
    publicOnly(child, `${at}.${key}`);
  }
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /fixture-(?:private-model|provider-private|account-private|quota-private|window-private)|87\.654321|1357911|2468135/);
}

test('isolated actual /chat service: routing, auth, privacy, topics, history, and 100 SSE clients', { timeout: 35000 }, async (t) => {
  const f = await serviceFixture(t);
  const post = (route, body, options = {}) => f.request('/chat' + route, { method: 'POST', origin: f.origin, body, ...options });
  const state = async (cookie) => {
    const response = await f.request('/chat/api/state', { cookie });
    assert.equal(response.status, 200);
    return response.json;
  };
  const stopped = async () => {
    const value = await state();
    assert.equal(value.room.running, false);
    assert.equal(value.room.sleeping, true);
    return value;
  };

  await t.test('root redirects and mounted pages/assets/APIs use the real router', async () => {
    for (const [route, location] of [['/', '/chat/'], ['/admin', '/chat/admin'], ['/chat?from=fixture', '/chat/?from=fixture'], ['/app.js', '/chat/app.js']]) {
      const response = await f.request(route);
      assert.equal(response.status, 308, route);
      assert.equal(response.headers.location, location);
    }
    for (const route of ['/chat/', '/chat/admin', '/chat/world.html', '/chat/licenses', '/chat/topics']) {
      const response = await f.request(route);
      assert.equal(response.status, 200, route);
      assert.match(response.headers['content-type'], /text\/html/);
      assert.match(response.text, /name="chatroom-base" content="\/chat"/);
      for (const match of response.text.matchAll(/\b(?:href|src|action)=["'](\/[^"']*)/g)) assert.ok(match[1].startsWith('/chat/'), `${route}: ${match[1]}`);
    }
    for (const route of ['/chat/app.js', '/chat/base-path.js', '/chat/style.css', '/chat/living-view.js']) assert.equal((await f.request(route)).status, 200, route);
    const portrait = await f.request('/chat/assets/characters/adina/avatar.png');
    assert.equal(portrait.status, 200);
    assert.match(portrait.headers['content-type'], /image\/png/);
    for (const route of ['/api/state', '/events', '/chatty/api/state', '/chat/config.json', '/chat/.env', '/chat/data/messages.jsonl', '/chat/assets/characters/gpt/avatar.png']) {
      assert.equal((await f.request(route)).status, 404, route);
    }
    assert.equal((await f.request('/', { headers: { Host: 'public.example.invalid' } })).status, 404);
    const world = await f.request('/chat/api/world');
    assert.equal(world.status, 200);
    assert.ok(world.json.blocks.some((block) => JSON.stringify(block) === JSON.stringify([12, 1, 12, 'planks'])));
    assert.ok(world.json.avatars.adina);
    const health = await f.request('/chat/api/health');
    assert.equal(health.status, 200); assert.equal(health.json.ok, true);
    const living = await f.request('/chat/api/living');
    assert.equal(living.status, 200);
    assert.equal(living.json.version, 1);
    assert.equal(living.json.meal, null);
    assert.equal(living.json.game, null);
    assert.equal(typeof living.json.pausedAt, 'number');
    publicOnly(living.json);
    assert.equal((await post('/api/living', { op: 'game_create' })).status, 401);
    assert.deepEqual((await f.request('/chat/api/living')).json, living.json);
  });

  await t.test('real admin cookie, origin checks, denied viewer writes, and logout revocation', async () => {
    assert.deepEqual((await f.request('/chat/api/session')).json, { role: 'viewer', authenticated: false });
    for (const route of ['/api/send', '/api/react', '/api/room', '/api/member', '/api/admin/topics', '/api/usage/refresh']) {
      assert.equal((await post(route, { text: 'must not post', running: true, id: 2, emoji: '👍' })).status, 401, route);
    }
    for (const route of ['/api/admin/topics', '/api/admin/settings', '/api/admin/raw/state', '/api/usage']) {
      assert.equal((await f.request('/chat' + route)).status, 401, route);
    }
    assert.equal((await f.request('/chat/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 403);
    assert.equal((await post('/api/admin/login', { password: 'wrong' }, { origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await post('/api/admin/login', { password: 'wrong' }, { headers: { Host: 'localhost:1' } })).status, 403);
    assert.equal((await post('/api/admin/login', { password: 'wrong' })).status, 401);
    const login = await f.login();
    assert.match(login.header, /; HttpOnly(?:;|$)/);
    assert.match(login.header, /; SameSite=Strict(?:;|$)/);
    assert.match(login.header, /; Path=\/chat\/(?:;|$)/);
    assert.deepEqual((await f.request('/chat/api/session', { cookie: login.cookie })).json, { role: 'admin', authenticated: true });
    assert.equal((await post('/api/room', { running: true }, { cookie: login.cookie, origin: 'https://untrusted.invalid' })).status, 403);
    const changed = await post('/api/room', { speed: 'slow' }, { cookie: login.cookie });
    assert.equal(changed.status, 200);
    const logout = await post('/api/admin/logout', {}, { cookie: login.cookie });
    assert.equal(logout.status, 200);
    assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await post('/api/room', { running: true }, { cookie: login.cookie })).status, 401);
    await stopped();
  });

  await t.test('public state and live SSE omit quota/model metadata for viewers and admins', async () => {
    const { cookie } = await f.login();
    const viewer = await f.openSse(), admin = await f.openSse(cookie);
    try {
      assert.equal(viewer.status, 200); assert.equal(admin.status, 200);
      await viewer.waitFor('session', (data) => data.role === 'viewer');
      await admin.waitFor('session', (data) => data.role === 'admin');
      for (const sessionCookie of [undefined, cookie]) {
        const value = await state(sessionCookie);
        publicOnly(value);
        assert.equal(value.messages.length, 80);
        assert.ok(Object.values(value.sleeps).every((entry) => entry.state === 'asleep'));
        assert.ok(value.members.some((member) => member.id === 'adina'));
      }
      // Prove that the raw source contains private canaries; their absence from
      // browser surfaces must not be an artifact of an empty usage stub.
      const raw = await f.request('/chat/api/admin/raw/state', { cookie });
      assert.equal(raw.status, 200);
      assert.match(raw.text, /fixture-private-model-v9/);
      assert.match(raw.text, /87\.654321/);
      await f.emitUsage();
      assert.equal((await post('/api/room', { speed: 'normal' }, { cookie })).status, 200);
      assert.equal((await post('/api/react', { id: 2, emoji: '👍' }, { cookie })).status, 200);
      for (const stream of [viewer, admin]) {
        await stream.waitFor('room'); await stream.waitFor('members'); await stream.waitFor('sleeps');
        const update = await stream.waitFor('msgupdate', (data) => data.id === 2);
        assert.equal(update.data.attach.desc, '뒤늦은 설명 🐱');
        assert.deepEqual(update.data.reactions['🌷'], ['eleven']);
        assert.deepEqual(update.data.reactions['👍'], ['user']);
        assert.ok(!stream.events.some((event) => ['usage', 'batteries', 'quota'].includes(event.type)));
        for (const event of stream.events) publicOnly(event.data);
      }
      assert.equal((await post('/api/admin/logout', {}, { cookie })).status, 200);
      await admin.waitFor('session', (data) => data.role === 'viewer');
    } finally { viewer.close(); admin.close(); }
    await stopped();
  });

  await t.test('visitor consent, private pending topics, exact approval versions, and no automatic wake', async () => {
    const { cookie } = await f.login();
    const stream = await f.openSse();
    try {
      await stream.waitFor('session');
      const input = { title: '통합 검증 전용 이야기', text: '낮에 만든 종이배를 함께 구경해요. 비공개대기표식', sourceUrl: '' };
      assert.equal((await post('/api/topics/submit', input)).status, 400);
      assert.equal((await post('/api/topics/submit', { ...input, consent: false })).status, 400);
      const submitted = await post('/api/topics/submit', { ...input, consent: true });
      assert.equal(submitted.status, 202);
      assert.deepEqual(submitted.json, { accepted: true, duplicate: false, mailStatus: 'saved' });
      assert.equal((await post('/api/topics/submit', { ...input, consent: true })).status, 202);
      const publicTopics = await f.request('/chat/api/topics');
      assert.equal(publicTopics.status, 200); assert.deepEqual(publicTopics.json.items, []);
      assert.equal((await f.request('/chat/api/admin/topics')).status, 401);
      const privateTopics = await f.request('/chat/api/admin/topics', { cookie });
      assert.equal(privateTopics.status, 200); assert.equal(privateTopics.json.items.length, 1);
      const item = privateTopics.json.items[0];
      assert.equal(item.status, 'pending'); assert.equal(item.text, input.text);
      const expectedVersion = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      assert.equal(item.version, expectedVersion);
      assert.equal((await post('/api/admin/topics', { id: item.id, version: item.version, action: 'approve' })).status, 401);
      assert.equal((await post('/api/admin/topics', { id: item.id, action: 'approve' }, { cookie })).status, 409);
      assert.equal((await post('/api/admin/topics', { id: item.id, version: 'stale-version', action: 'approve' }, { cookie })).status, 409);
      assert.equal((await f.request('/chat/api/admin/topics', { cookie })).json.items[0].status, 'pending');
      const messageBytes = fs.readFileSync(path.join(f.data, 'messages.jsonl'));
      const review = { id: item.id, version: item.version, action: 'approve' };
      assert.equal((await post('/api/admin/topics', review, { cookie })).status, 200);
      assert.equal((await post('/api/admin/topics', review, { cookie })).status, 200, 'same approval is idempotent');
      assert.equal((await post('/api/admin/topics', { ...review, action: 'reject' }, { cookie })).status, 409);
      await pause(1200); // Allow multiple real 500-ms scheduler ticks.
      const stillAsleep = await stopped();
      assert.doesNotMatch(JSON.stringify(stillAsleep), /비공개대기표식/);
      assert.doesNotMatch(stream.text, /비공개대기표식/);
      assert.deepEqual((await f.request('/chat/api/topics')).json.items, []);
      assert.equal((await f.request('/chat/api/admin/topics', { cookie })).json.items[0].status, 'approved');
      const disk = JSON.parse(fs.readFileSync(path.join(f.data, 'topics.json'), 'utf8'));
      assert.equal(disk.items[0].version, expectedVersion); assert.equal(disk.items[0].consent, true);
      assert.equal(disk.activeId, null);
      assert.deepEqual(fs.readFileSync(path.join(f.data, 'messages.jsonl')), messageBytes, 'topics do not insert unsolicited chat');
      const metrics = await f.metrics();
      assert.deepEqual(metrics.violations, []); assert.ok(metrics.usagePolls >= 1);
    } finally { stream.close(); }
  });

  await t.test('actual history route pages beyond the ring and preserves late overlays and log bytes', async () => {
    const original = fs.readFileSync(path.join(f.data, 'messages.jsonl'));
    const latest = await state();
    let before = latest.messages[0].id;
    const ids = [];
    let oldPhoto;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const response = await f.request(`/chat/api/history?before=${before}&limit=999999`);
      assert.equal(response.status, 200);
      const page = response.json.messages;
      assert.ok(page.length <= 200);
      publicOnly(page);
      if (!page.length) break;
      assert.ok(page.every((message) => message.id < before));
      assert.deepEqual(page.map((message) => message.id), [...page.map((message) => message.id)].sort((a, b) => a - b));
      oldPhoto ??= page.find((message) => message.id === 2);
      ids.unshift(...page.map((message) => message.id));
      before = page[0].id;
    }
    ids.push(...latest.messages.map((message) => message.id));
    assert.deepEqual(ids, Array.from({ length: f.messageCount }, (_, i) => i + 1));
    assert.equal(oldPhoto.attach.desc, '뒤늦은 설명 🐱');
    assert.deepEqual(oldPhoto.reactions['🌷'], ['eleven']);
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'messages.jsonl')), original);
  });

  await t.test('100 actual SSE connections fill the cap; 101st is 503; released capacity is reusable', async (sub) => {
    const started = performance.now(), baseline = await f.metrics();
    let clients = [];
    try {
      clients = await Promise.all(Array.from({ length: 100 }, () => f.openSse()));
      assert.ok(clients.every((client) => client.status === 200), 'all first 100 SSE requests admitted');
      await Promise.all(clients.map((client) => client.waitFor('session')));
      assert.equal(new Set(clients.map((client) => client.localPort)).size, 100, '100 distinct TCP sockets');
      const full = await f.metrics();
      const rejected = await f.request('/chat/events');
      assert.equal(rejected.status, 503); assert.ok(Number(rejected.headers['retry-after']) > 0);
      assert.equal((await f.request('/chat/api/health')).status, 200, 'ordinary requests remain available at the SSE cap');
      for (const client of clients.splice(0, 25)) client.close();
      // A close travels over TCP; allow bounded retries while the server handles
      // its close event, without assuming the client sees that event first.
      const replacements = [];
      const deadline = performance.now() + 3000;
      while (replacements.length < 25 && performance.now() < deadline) {
        const connection = await f.openSse();
        if (connection.status === 200) replacements.push(connection);
        else { assert.equal(connection.status, 503); connection.close(); await pause(20); }
      }
      clients.push(...replacements);
      assert.equal(clients.length, 100, 'all 25 released slots restored');
      await Promise.all(replacements.map((client) => client.waitFor('session')));
      assert.equal((await f.request('/chat/events')).status, 503, 'restored cap still enforced');
      for (const client of clients) client.close();
      clients = [];
      await pause(100);
      clients = await Promise.all(Array.from({ length: 100 }, () => f.openSse()));
      assert.ok(clients.every((client) => client.status === 200), 'all capacity and per-address counters release');
      await Promise.all(clients.map((client) => client.waitFor('session')));
      const restored = await f.metrics();
      sub.diagnostic(`100 sockets + overflow + 25-slot restoration + full reconnection: ${(performance.now() - started).toFixed(1)} ms. Child RSS MiB: before ${(baseline.rss / 1024 ** 2).toFixed(1)}, full ${(full.rss / 1024 ** 2).toFixed(1)}, reconnected ${(restored.rss / 1024 ** 2).toFixed(1)}. Short synthetic observation only.`);
    } finally { for (const client of clients) client.close(); }
  });
  await stopped();
  const metrics = await f.metrics();
  assert.equal(metrics.guardInstalled, true);
  assert.deepEqual(metrics.violations, []);
  await t.test('application readiness/health instance contract and graceful child stop preserve saved flags', async (sub) => {
    assert.equal(Number(fs.readFileSync(path.join(f.data, 'server.pid'), 'utf8')), f.ready.pid);
    const wrongRequest = 'wrong-instance-probe';
    f.sendService({ type: 'service:health', instanceId: 'wrong-instance', requestId: wrongRequest });
    f.sendService({ type: 'shutdown', instanceId: 'wrong-instance' });
    await f.metrics(); // IPC barrier: both wrong-instance messages were handled.
    assert.ok(!f.serviceMessages.some((message) => message.requestId === wrongRequest));
    const health = await f.health();
    assert.equal(health.ready, true); assert.equal(health.roomRunning, false);
    assert.equal(health.pid, f.ready.pid); assert.equal(health.instanceId, f.instanceId);
    const before = JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'), 'utf8'));
    const messages = fs.readFileSync(path.join(f.data, 'messages.jsonl'));
    const result = await f.shutdown();
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    const after = JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'), 'utf8'));
    assert.equal(after.room.running, false); assert.equal(after.room.sleeping, true);
    assert.equal(after.room.running, before.room.running); assert.equal(after.room.sleeping, before.room.sleeping);
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'messages.jsonl')), messages);
    sub.diagnostic(`Application IPC shutdown completed in ${result.durationMs.toFixed(1)} ms; no fixture force-stop used.`);
  });
});

test('isolated actual service preserves a sleeping room when supervisor IPC disconnects', { timeout: 15000 }, async (t) => {
  const f = await serviceFixture(t, { messageCount: 2 });
  const stream = await f.openSse();
  await stream.waitFor('session');
  const result = await f.shutdown({ disconnect: true });
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  const state = JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'), 'utf8'));
  assert.equal(state.room.running, false); assert.equal(state.room.sleeping, true);
  t.diagnostic(`Application disconnect shutdown completed in ${result.durationMs.toFixed(1)} ms with an open SSE client.`);
});
