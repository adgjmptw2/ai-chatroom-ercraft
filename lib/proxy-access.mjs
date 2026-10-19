import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { loopbackAddress } from './http-limits.mjs';

export function validProxyToken(req, secret) {
  const supplied = req.headers?.['x-chatroom-proxy-token'];
  return loopbackAddress(req.socket?.remoteAddress) && typeof secret === 'string' && secret.length >= 32
    && typeof supplied === 'string' && Buffer.byteLength(secret) === Buffer.byteLength(supplied)
    && timingSafeEqual(Buffer.from(secret), Buffer.from(supplied));
}

export function proxyAccess(req, { required = false, secret } = {}) {
  if (!required) return true;
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const headers = req.headers || {};
  const local = loopbackAddress(req.socket?.remoteAddress)
    && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(headers.host || '')
    && !['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip',
      'x-chatroom-client-ip', 'x-chatroom-proxy-token'].some(key => headers[key] !== undefined);
  return local || (validProxyToken(req, secret) && typeof headers['x-chatroom-client-ip'] === 'string'
    && isIP(headers['x-chatroom-client-ip']) !== 0);
}
