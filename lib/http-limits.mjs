import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export const loopbackAddress = value => value === '::1' || value === '127.0.0.1' || value === '::ffff:127.0.0.1';

// A forwarding header is trusted only on an authenticated local proxy hop.
export function clientAddress(req, proxy = {}) {
  const remote = req.socket?.remoteAddress || 'unknown';
  const secret = proxy.secret;
  const supplied = req.headers?.['x-chatroom-proxy-token'];
  if (loopbackAddress(remote) && typeof secret === 'string' && secret.length >= 32
      && typeof supplied === 'string' && Buffer.byteLength(secret) === Buffer.byteLength(supplied)
      && timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) {
    const address = req.headers?.[proxy.header || 'cf-connecting-ip'];
    if (typeof address === 'string' && isIP(address)) return address;
  }
  return remote;
}

export class WindowLimiter {
  constructor({ limit = 120, windowMs = 60000, maxKeys = 1024, now = Date.now } = {}) {
    Object.assign(this, { limit, windowMs, maxKeys, now }); this.entries = new Map();
  }
  take(key) {
    const now = this.now();
    for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
    let value = this.entries.get(key);
    if (!value) {
      if (this.entries.size >= this.maxKeys) return false;
      value = { count: 0, until: now + this.windowMs }; this.entries.set(key, value);
    }
    if (value.count >= this.limit) return false;
    value.count++; return true;
  }
}

export class EventHub {
  constructor({ maxClients = 256, perAddress = 128, maxBufferedBytes = 262144, blockedMs = 5000 } = {}) {
    Object.assign(this, { maxClients, perAddress, maxBufferedBytes, blockedMs });
    this.clients = new Map(); this.addresses = new Map();
  }
  add(req, res, address) {
    if (this.clients.size >= this.maxClients || (this.addresses.get(address) || 0) >= this.perAddress) return false;
    const entry = { address, blocked: false, timer: null };
    this.clients.set(res, entry); this.addresses.set(address, (this.addresses.get(address) || 0) + 1);
    const remove = () => this.remove(res);
    req.once('close', remove); res.once('close', remove); res.once('error', remove);
    return true;
  }
  remove(res) {
    const entry = this.clients.get(res); if (!entry) return;
    clearTimeout(entry.timer); this.clients.delete(res);
    const n = this.addresses.get(entry.address) - 1;
    if (n) this.addresses.set(entry.address, n); else this.addresses.delete(entry.address);
  }
  drop(res) { this.remove(res); res.destroy(); }
  write(res, text) {
    const entry = this.clients.get(res); if (!entry) return false;
    if (res.destroyed || res.writableEnded || entry.blocked
        || (res.writableLength || 0) + Buffer.byteLength(text) > this.maxBufferedBytes) {
      this.drop(res); return false;
    }
    try {
      if (!res.write(text)) {
        entry.blocked = true;
        entry.timer = setTimeout(() => this.drop(res), this.blockedMs); entry.timer.unref?.();
        res.once('drain', () => { clearTimeout(entry.timer); entry.blocked = false; });
      }
      return true;
    } catch { this.drop(res); return false; }
  }
  close() { for (const res of this.clients.keys()) this.drop(res); }
}

export function readJsonBody(req, limit = 200000, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      req.removeListener('data', onData); req.removeListener('end', onEnd);
      req.removeListener('aborted', onAbort); req.removeListener('error', onError);
      if (error) {
        // A socket may emit error after aborted/timeout. Drain without retaining
        // the partial body and absorb that terminal stream error.
        req.on('error', () => {}); req.resume(); reject(error);
      } else resolve(value);
    };
    const onData = data => { size += data.length; if (size > limit) finish(new Error('too large')); else chunks.push(data); };
    const onEnd = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { finish(new Error('invalid json')); } };
    const onAbort = () => finish(new Error('aborted'));
    const onError = () => finish(new Error('request error'));
    const timer = setTimeout(() => finish(new Error('body timeout')), timeoutMs); timer.unref?.();
    req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAbort); req.once('error', onError);
    if (req.aborted || req.destroyed) onAbort();
  });
}

export function normalizeBasePath(value = '') {
  if (value === '' || value === '/') return '';
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(value)) throw new Error('Invalid public base path');
  return value.replace(/\/$/, '');
}

export function mountHtml(html, base) {
  const meta = `<meta name="chatroom-base" content="${base}">`;
  return html.replace(/<head>/i, `<head>${meta}`)
    .replace(/\b(href|src|action)=(['"])\/(?!\/)([^'"]*)\2/g, (_, key, quote, rest) => `${key}=${quote}${base}/${rest}${quote}`);
}
