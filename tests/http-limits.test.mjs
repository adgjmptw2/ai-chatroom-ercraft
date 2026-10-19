import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { clientAddress, WindowLimiter, EventHub, readJsonBody, normalizeBasePath, mountHtml } from '../lib/http-limits.mjs';
test('forwarded address needs authenticated local proxy, spoofed headers ignored', () => {
  const secret = 'a'.repeat(32), req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '1.2.3.4' } };
  assert.equal(clientAddress(req, { secret }), '127.0.0.1');
  req.headers['x-chatroom-proxy-token'] = secret;
  assert.equal(clientAddress(req, { secret }), '1.2.3.4');
  req.socket.remoteAddress = '8.8.8.8'; assert.equal(clientAddress(req, { secret }), '8.8.8.8');
});
test('rate counters have hard key caps and expire', () => {
  let now = 0; const limiter = new WindowLimiter({ limit: 2, maxKeys: 2, windowMs: 100, now: () => now });
  assert.ok(limiter.take('a')); assert.ok(limiter.take('a')); assert.equal(limiter.take('a'), false);
  assert.ok(limiter.take('b')); assert.equal(limiter.take('c'), false); assert.equal(limiter.entries.size, 2);
  now = 100; assert.ok(limiter.take('c')); assert.equal(limiter.entries.size, 1);
});
function client(writable = true) {
  const req = new EventEmitter(), res = new EventEmitter();
  Object.assign(res, { write: () => writable, destroy() { this.destroyed = true; this.emit('close'); } }); return { req, res };
}
test('SSE limits and slow clients release capacity without unbounded writes', () => {
  const hub = new EventHub({ maxClients: 2, perAddress: 1, maxBufferedBytes: 32 });
  const first = client(false), second = client(), extra = client();
  assert.ok(hub.add(first.req, first.res, 'a')); assert.equal(hub.add(extra.req, extra.res, 'a'), false);
  assert.ok(hub.add(second.req, second.res, 'b')); assert.equal(hub.add(extra.req, extra.res, 'c'), false);
  assert.ok(hub.write(first.res, 'hello')); assert.equal(hub.write(first.res, 'again'), false); assert.ok(first.res.destroyed);
  assert.ok(hub.add(extra.req, extra.res, 'a')); assert.equal(hub.write(extra.res, 'a'.repeat(33)), false);
  hub.close(); assert.equal(hub.clients.size, 0); assert.equal(hub.addresses.size, 0);
});
test('body cap, abort, malformed json and successful parsing settle once', async () => {
  const req = new PassThrough(); const read = readJsonBody(req, 20); req.end('{"ok":true}'); assert.deepEqual(await read, { ok: true });
  const huge = new PassThrough(), large = readJsonBody(huge, 4); huge.end('12345'); await assert.rejects(large, /too large/);
  const bad = new PassThrough(), invalid = readJsonBody(bad); bad.end('{'); await assert.rejects(invalid, /invalid json/);
  const aborted = new PassThrough(), cancelled = readJsonBody(aborted); aborted.emit('aborted'); await assert.rejects(cancelled, /aborted/); aborted.emit('error', Error('late'));
});
test('mounted HTML keeps external URLs and scope meta, rejects unsafe paths', () => {
  assert.equal(normalizeBasePath('/chat/'), '/chat'); assert.throws(() => normalizeBasePath('/../chat'));
  assert.equal(mountHtml('<head></head><a href="/world.html"><img src="https://example.com/p.png">', '/chat'), '<head><meta name="chatroom-base" content="/chat"></head><a href="/chat/world.html"><img src="https://example.com/p.png">');
});
