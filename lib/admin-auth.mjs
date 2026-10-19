import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

const COOKIE = 'ai_chatroom_admin';
const DEFAULT_TTL = 12 * 60 * 60 * 1000;
const IP_WINDOW = 15 * 60 * 1000;
const GLOBAL_WINDOW = 60 * 60 * 1000;
const MAX_SESSIONS = 256;
const VIEWER = () => ({ role: 'viewer', authenticated: false });
const ADMIN = () => ({ role: 'admin', authenticated: true });
const digest = (value) => createHash('sha256').update(value).digest();
const failure = (status, error) => ({ ok: false, status, error });

function localHttpOrigin(url) {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function singleHeader(req, name) {
  const raw = req?.rawHeaders;
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length % 2) return null;
    let count = 0;
    for (let i = 0; i < raw.length; i += 2) {
      if (typeof raw[i] !== 'string' || typeof raw[i + 1] !== 'string') return null;
      if (raw[i].toLowerCase() === name && ++count > 1) return null;
    }
  }
  const value = req?.headers?.[name];
  if (value === undefined) return undefined;
  return typeof value === 'string' && !/[\r\n]/.test(value) ? value : null;
}

function ipAddress(req) {
  const ip = req?.socket?.remoteAddress;
  if (typeof ip !== 'string' || !isIP(ip)) return undefined;
  if (isIP(ip) === 4) return ip;
  let canonical;
  try { canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1); }
  catch { return undefined; }
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

function loopback(req) {
  const ip = ipAddress(req);
  return ip === '::1' || (isIP(ip ?? '') === 4 && ip.startsWith('127.'));
}

function randomToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

// Reject ambiguous cookies rather than choosing the first or last credential.
function cookies(req, cookieName) {
  const header = singleHeader(req, 'cookie');
  if (header === undefined) return {};
  if (header === null || !header || header.length > 8192) return null;
  const names = new Set();
  let token;
  for (const part of header.split(';')) {
    const pair = part.trim();
    const split = pair.indexOf('=');
    if (split < 1) return null;
    const name = pair.slice(0, split), value = pair.slice(split + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
      || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) return null;
    // Mounted services ignore legacy root/subpath credentials, but not bad syntax.
    if (cookieName !== COOKIE && name === COOKIE) continue;
    if (names.has(name)) return null;
    names.add(name);
    if (name === cookieName) {
      if (!randomToken(value)) return null;
      token = value;
    }
  }
  return { token };
}

function statIfPresent(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function smallFile(file, limit) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error();
  return readFileSync(file, 'utf8');
}

function credentials(data) {
  const stat = lstatSync(data);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  const state = JSON.parse(smallFile(join(data, 'admin-auth.json'), 4096));
  if (!state || Array.isArray(state) || Object.keys(state).sort().join(',') !== 'algorithm,passwordHash,version'
    || state.version !== 1 || state.algorithm !== 'sha256'
    || typeof state.passwordHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.passwordHash)) throw new Error();
  const text = smallFile(join(data, 'admin-password.txt'), 128);
  const password = text.replace(/\r?\n$/, '');
  if (!randomToken(password)) throw new Error();
  const hash = Buffer.from(state.passwordHash, 'hex');
  if (!timingSafeEqual(hash, digest(password))) throw new Error();
  return hash;
}

/**
 * All methods are synchronous. Only Node built-ins are used.
 *
 * allowedOrigins is an exact, canonical origin allowlist; [] denies every write.
 * Include localhost/127.0.0.1 HTTP origins on any port explicitly if desired.
 * Unlisted ports are never trusted automatically. These local origins additionally
 * require a loopback socket and Host equal to that origin's host:port. All other
 * entries must be HTTPS. HTTPS requires socket.encrypted === true, or a loopback
 * peer for an explicitly trusted local reverse proxy. That proxy must terminate
 * HTTPS and preserve Origin; no forwarded header establishes trust. HTTPS cookies
 * are Secure even on the local proxy hop. Direct local HTTP cookies are not.
 *
 * Fresh installations create data/admin-password.txt and data/admin-auth.json
 * with exclusive writes and mode 0600 (data/ must remain gitignored). The password
 * is 32 random bytes encoded as base64url; JSON contains only its SHA-256 hash.
 * Existing incomplete, corrupt, mismatched or linked credentials throw the generic
 * startup error without repair. Changes/removal during operation permanently
 * disable this instance and revoke its sessions; restart after a deliberate change.
 *
 * session(req): {role:'admin'|'viewer', authenticated:boolean}; isAdmin(req): boolean.
 * sessionKey(req): SHA-256 hex digest for a live session, otherwise undefined.
 * login(req,password): {ok:true,status:200,cookie,session}, or
 * {ok:false,status:400|401|403|429|503,error}; never returns the password or token
 * except the new token in Set-Cookie. logout(req): clearing Set-Cookie string.
 * trustedPost(req): boolean for POST/PUT/PATCH/DELETE with JSON and trusted origin.
 * The server must call trustedPost before reading every mutation body (including
 * logout), enforce its 4096-byte body limit, and recheck isAdmin after any await.
 * Reads remain public. Never accept credentials from URLs. Sessions live only in
 * memory, expire after sessionTtlMs (default 12h), and disappear on restart.
 */
export class AdminAuth {
  #data;
  #hash;
  #origins;
  #ttl;
  #disabled = false;
  #sessions = new Map();
  #failures = new Map();
  #globalFailures = [];
  #cookiePath;
  #cookieName;
  #loginAddress;

  constructor(home, { allowedOrigins = [], sessionTtlMs = DEFAULT_TTL, cookiePath = '/', loginAddress = ipAddress } = {}) {
    if (typeof loginAddress !== 'function') throw new Error('Invalid login address resolver');
    this.#loginAddress = loginAddress;
    if (typeof cookiePath !== 'string' || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(cookiePath)) throw new Error('Invalid admin cookie path');
    this.#cookiePath = cookiePath;
    this.#cookieName = cookiePath === '/' ? COOKIE : `${COOKIE}_${digest(cookiePath).toString('hex').slice(0, 16)}`;
    if (!Array.isArray(allowedOrigins) || !Number.isSafeInteger(sessionTtlMs)
      || sessionTtlMs < 1 || sessionTtlMs > DEFAULT_TTL * 60) {
      throw new Error('Invalid admin auth settings');
    }
    this.#origins = new Set(allowedOrigins.map((origin) => {
      try {
        const url = new URL(origin);
        if (typeof origin !== 'string' || url.origin !== origin || url.username || url.password
          || (url.protocol !== 'https:' && !localHttpOrigin(url))) throw new Error();
        return origin;
      } catch { throw new Error('Invalid admin auth settings'); }
    }));
    this.#ttl = sessionTtlMs;
    try {
      this.#data = join(home, 'data');
      mkdirSync(this.#data, { recursive: true, mode: 0o700 });
      const dir = lstatSync(this.#data);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error();
      const stateFile = join(this.#data, 'admin-auth.json');
      const passwordFile = join(this.#data, 'admin-password.txt');
      const state = statIfPresent(stateFile), password = statIfPresent(passwordFile);
      if (!state && !password) {
        const secret = randomBytes(32).toString('base64url');
        // A crash between exclusive writes intentionally leaves a closed state.
        writeFileSync(passwordFile, `${secret}\n`, { flag: 'wx', mode: 0o600 });
        writeFileSync(stateFile, JSON.stringify({ version: 1, algorithm: 'sha256', passwordHash: digest(secret).toString('hex') }) + '\n',
          { flag: 'wx', mode: 0o600 });
      }
      this.#hash = credentials(this.#data);
    } catch { throw new Error('Admin auth credentials unavailable'); }
  }

  #healthy() {
    if (this.#disabled) return false;
    try {
      if (!timingSafeEqual(this.#hash, credentials(this.#data))) throw new Error();
      return true;
    } catch {
      this.#disabled = true;
      this.#sessions.clear();
      return false;
    }
  }

  #prune(now) {
    for (const [key, session] of this.#sessions) {
      if (session.expires <= now) this.#sessions.delete(key);
    }
    for (const [ip, failures] of this.#failures) {
      const recent = failures.filter((at) => at > now - IP_WINDOW);
      if (recent.length) this.#failures.set(ip, recent);
      else this.#failures.delete(ip);
    }
    this.#globalFailures = this.#globalFailures.filter((at) => at > now - GLOBAL_WINDOW);
  }

  trustedPost(req) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req?.method)) return false;
    const type = singleHeader(req, 'content-type'), origin = singleHeader(req, 'origin');
    if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type.trim())
      || typeof origin !== 'string' || !this.#origins.has(origin)) return false;
    const url = new URL(origin);
    if (localHttpOrigin(url)) {
      return loopback(req) && singleHeader(req, 'host') === url.host;
    }
    return req?.socket?.encrypted === true || loopback(req);
  }

  sessionKey(req) {
    const parsed = cookies(req, this.#cookieName);
    if (!parsed?.token) return undefined;
    this.#prune(Date.now());
    const key = digest(parsed.token).toString('hex'), session = this.#sessions.get(key);
    if (!session) return undefined;
    if (session.secure) {
      if (req?.socket?.encrypted !== true && !loopback(req)) return undefined;
    } else if (!loopback(req) || singleHeader(req, 'host') !== session.host) return undefined;
    return this.#healthy() ? key : undefined;
  }

  session(req) { return this.sessionKey(req) ? ADMIN() : VIEWER(); }
  isAdmin(req) { return this.sessionKey(req) !== undefined; }

  login(req, password) {
    if (!this.trustedPost(req)) return failure(403, 'Untrusted request');
    if (!this.#healthy()) return failure(503, 'Admin authentication unavailable');
    const parsed = cookies(req, this.#cookieName);
    let ip;
    try { ip = this.#loginAddress(req); } catch { return failure(400, 'Invalid request'); }
    if (!parsed || typeof ip !== 'string' || !isIP(ip)) return failure(400, 'Invalid request');
    const now = Date.now();
    this.#prune(now);
    // At most 30 failures (and thus IP entries) can survive the global window.
    const failures = this.#failures.get(ip) ?? [];
    if (failures.length >= 5 || this.#globalFailures.length >= 30) return failure(429, 'Too many login attempts');
    const validInput = typeof password === 'string' && password.length <= 512
      && Buffer.byteLength(password, 'utf8') <= 512;
    const supplied = digest(validInput ? password : '');
    const matched = timingSafeEqual(this.#hash, supplied);
    if (!validInput || !matched) {
      failures.push(now);
      this.#failures.set(ip, failures);
      this.#globalFailures.push(now);
      return failure(validInput ? 401 : 400, validInput ? 'Invalid credentials' : 'Invalid request');
    }
    if (parsed.token) this.#sessions.delete(digest(parsed.token).toString('hex'));
    if (this.#sessions.size >= MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const origin = singleHeader(req, 'origin');
    const secure = req?.socket?.encrypted === true || origin.startsWith('https:');
    this.#sessions.set(digest(token).toString('hex'), { expires: now + this.#ttl, secure, host: new URL(origin).host });
    return { ok: true, status: 200,
      cookie: `${this.#cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${this.#cookiePath}; Max-Age=${Math.ceil(this.#ttl / 1000)}${secure ? '; Secure' : ''}`,
      session: ADMIN() };
  }

  logout(req) {
    const parsed = cookies(req, this.#cookieName);
    const key = parsed?.token ? digest(parsed.token).toString('hex') : undefined;
    const session = this.#sessions.get(key);
    if (key) this.#sessions.delete(key);
    const origin = singleHeader(req, 'origin');
    const secure = req?.socket?.encrypted === true || session?.secure === true
      || (typeof origin === 'string' && origin.startsWith('https:') && this.#origins.has(origin) && loopback(req));
    return `${this.#cookieName}=; HttpOnly; SameSite=Strict; Path=${this.#cookiePath}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
  }
}
