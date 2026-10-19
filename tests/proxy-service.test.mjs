import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture } from './helpers/service-fixture.mjs';

test('actual isolated public gateway rejects origin bypass, preserves auth and separates visitor limits', { timeout: 30000 }, async t => {
  const f = await serviceFixture(t, { gateway: true, messageCount: 2 });
  const proxy = {
    Host: 'api.ercraft.net', 'X-Chatroom-Proxy-Token': 'fixture-proxy-'.repeat(4),
    'X-Chatroom-Client-IP': '203.0.113.1', 'CF-Connecting-IP': '2a06:98c0:3600::103',
  };
  for (const route of ['/chat', '/chat/', '/chat/app.js', '/chat/ercraft-symbol.png', '/chat/api/state']) {
    const denied = await f.request(route, { headers: { Host: 'api.ercraft.net' } });
    assert.equal(denied.status, 404, route);
    assert.equal(denied.headers['cache-control'], 'no-store');
    assert.equal(denied.headers['x-ercraft-chat-gate'], 'required');
    const accepted = await f.request(route, { headers: proxy });
    assert.equal(accepted.status, route === '/chat' ? 308 : 200, route);
  }
  for (const route of ['/chat/api/dev/state', '/chat/api%2Fdev/state', '/chat/API/dev/state'])
    assert.equal((await f.request(route, { headers: proxy })).status, 404);
  assert.equal((await f.request('/chat/api/state')).status, 200, 'local maintenance remains available');
  const { cookie, header } = await f.login({ headers: proxy, publicOrigin: 'https://ercraft.net' });
  assert.match(header, /; Secure/);
  assert.equal((await f.request('/chat/api/session', { headers: proxy, cookie })).json.authenticated, true);
  const forbidden = await f.request('/chat/api/room', { method: 'POST', origin: 'https://ercraft.net', headers: proxy, body: { running: true } });
  assert.equal(forbidden.status, 401);
  for (let i = 0; i < 5; i++) {
    const accepted = await f.request('/chat/api/topics/submit', { method: 'POST', origin: 'https://ercraft.net', headers: proxy,
      body: { title: `합성 제보 ${i}`, text: '격리 테스트 이야기', consent: true } });
    assert.equal(accepted.status, 202);
  }
  const submit = headers => f.request('/chat/api/topics/submit', { method: 'POST', origin: 'https://ercraft.net', headers,
    body: { title: '다른 방문자 이야기', text: '격리 테스트 이야기', consent: true } });
  assert.equal((await submit(proxy)).status, 429);
  assert.equal((await submit({ ...proxy, 'X-Chatroom-Client-IP': '203.0.113.2' })).status, 202);
  assert.equal((await f.request('/chat/api/state')).json.room.running, false);
  // One visitor's invalid passwords must not lock out the owner or other visitors.
  for (let i = 0; i < 5; i++) {
    const failed = await f.request('/chat/api/admin/login', { method: 'POST', origin: 'https://ercraft.net', headers: proxy, body: { password: 'incorrect-fixture-password' } });
    assert.equal(failed.status, 401);
  }
  assert.equal((await f.request('/chat/api/admin/login', { method: 'POST', origin: 'https://ercraft.net', headers: proxy, body: { password: 'incorrect-fixture-password' } })).status, 429);
  await f.login({ headers: { ...proxy, 'X-Chatroom-Client-IP': '203.0.113.2' }, publicOrigin: 'https://ercraft.net' });
  await f.login();
});
