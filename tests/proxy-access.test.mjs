import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyAccess } from '../lib/proxy-access.mjs';
import { clientAddress } from '../lib/http-limits.mjs';
const secret = 'p'.repeat(48), options = { required: true, secret };
const req = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers: { host: 'localhost:8321', ...headers }, socket: { remoteAddress } });
test('local maintenance survives, unauthenticated tunnel and forwarded localhost fail closed', () => {
  assert.equal(proxyAccess(req(), options), true);
  assert.equal(proxyAccess(req({ host: 'api.ercraft.net' }), options), false);
  for (const header of ['forwarded', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-chatroom-client-ip'])
    assert.equal(proxyAccess(req({ [header]: '203.0.113.1' }), options), false);
  assert.equal(proxyAccess(req(), { required: true }), false);
});
test('only authenticated local proxy with valid dedicated IP is admitted and separately counted', () => {
  const a = req({ host: 'api.ercraft.net', 'x-chatroom-proxy-token': secret, 'x-chatroom-client-ip': '203.0.113.1', 'cf-connecting-ip': '2a06:98c0:3600::103' });
  const b = req({ ...a.headers, 'x-chatroom-client-ip': '203.0.113.2' });
  assert.equal(proxyAccess(a, options), true);
  assert.equal(proxyAccess(b, options), true);
  assert.equal(clientAddress(a, { secret, header: 'x-chatroom-client-ip' }), '203.0.113.1');
  assert.equal(clientAddress(b, { secret, header: 'x-chatroom-client-ip' }), '203.0.113.2');
  assert.equal(proxyAccess(req(a.headers, '203.0.113.3'), options), false);
  assert.equal(proxyAccess(req({ ...a.headers, 'x-chatroom-proxy-token': 'wrong' }), options), false);
  assert.equal(proxyAccess(req({ ...a.headers, 'x-chatroom-client-ip': 'bogus' }), options), false);
});
