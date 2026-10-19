// Read-only public copies. No file renames, rewrites, image generators or external tools.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { neutralToken } from './public-identity.mjs';

const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const KEEP = new Set(['IHDR','PLTE','IDAT','IEND','tRNS','cHRM','gAMA','sRGB','sBIT','bKGD','pHYs','acTL','fcTL','fdAT']);
const PLAIN = new Set(['.txt','.md','.csv','.tsv']);
const SOURCE = new Set(['.svg','.xml','.html','.htm','.css','.js','.mjs','.ts','.py','.json','.yaml','.yml']);
const SOURCE_MIME = { '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const MAX_BYTES = 32 * 1024 * 1024;
const PNG_CACHE_LIMIT = 24 * 1024 * 1024;
const COPY_CACHE_LIMIT = 8 * 1024 * 1024;
const pngCache = new Map(), pngFiles = new Map();
let pngCacheBytes = 0;
export const PUBLIC_IMAGE_NOTICE = 'Public image copy; provenance metadata removed; may include AI-generated content.';

// Scan common encodings without ever replacing executable source. Deliberately
// reject XML entity definitions and encoded payload constructors we cannot inspect.
export function safePublicSource(source, privacy) {
  const declarations = source.replace(/<!doctype\s+html\s*>/gi, '');
  if (/<!\s*(?:DOCTYPE|ENTITY)|<\s*metadata\b/i.test(declarations)) return false;
  let scan = source;
  for (let i = 0; i < 4; i++) {
    if (privacy.sensitivePath(scan)) return false;
    const decoded = scan
      .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|&#x([0-9a-f]+);?|&#([0-9]+);?/gi,
        (_,a,b,c,d,e) => { const n = parseInt(a || b || c || d || e, e ? 10 : 16); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; })
      .replace(/%([0-9a-f]{2})/gi, (_,hex) => String.fromCharCode(parseInt(hex,16)))
      .replace(/&(amp|lt|gt|quot|apos);/g, (_,name) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[name]);
    if (decoded === scan) break;
    scan = decoded;
  }
  if (privacy.sensitivePath(scan) || /\b(?:atob|fromCharCode|fromCodePoint|eval)\s*\(|data:[^,]*;base64,/i.test(scan)) return false;
  // Unreviewed executable content can assemble arbitrary text at runtime. Keep
  // static artwork/documents public, without claiming to prove arbitrary code.
  if (/<\s*(?:script|foreignObject|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(scan)) return false;
  const visible = scan.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
  if (privacy.sensitivePath(visible) || privacy.sensitivePath(visible.replace(/\s+/g, ''))) return false;
  // Adjacent string literals are a common escaped model spelling in old source.
  return !privacy.sensitivePath(scan.replace(/['"`]\s*\+\s*['"`]/g, ''));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function cachedPng(hash) {
  const cached = pngCache.get(hash);
  if (cached) { pngCache.delete(hash); pngCache.set(hash,cached); }
  return cached;
}
function sanitizePng(bytes, hash) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || !bytes.subarray(0,8).equals(PNG)) throw new Error('Unavailable image');
  const chunks = [PNG]; let offset = 8, header = false, data = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Unavailable image');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('Unavailable image');
    if (!header && (type !== 'IHDR' || length !== 13)) throw new Error('Unavailable image');
    if (type === 'IHDR') { if (header) throw new Error('Unavailable image'); header = true; }
    if (type === 'IDAT') data = true;
    // Unknown critical chunks or ICC profiles need a format-aware implementation.
    // An ICC profile can contain compressed identifying metadata; do not leak it or
    // silently discard a required color profile. Such images are raw-admin-only.
    if (type === 'iCCP' || !KEEP.has(type) && /^[A-Z]/.test(type)) throw new Error('Unavailable image');
    if (KEEP.has(type)) chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === 'IEND') { if (length || !data) throw new Error('Unavailable image'); ended = true; break; }
  }
  if (!ended) throw new Error('Unavailable image');
  // Discard trailing bytes (including appended XMP/provenance).
  const result = Buffer.concat(chunks);
  if (result.length <= PNG_CACHE_LIMIT) {
    while (pngCache.size && (pngCacheBytes + result.length > PNG_CACHE_LIMIT || pngCache.size >= 128)) {
      const first=pngCache.keys().next().value;pngCacheBytes-=pngCache.get(first).length;pngCache.delete(first);
    }
    pngCache.set(hash,result);pngCacheBytes+=result.length;
  }
  return result;
}

export function publicPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw new Error('Unavailable image');
  const hash=createHash('sha256').update(bytes).digest('hex');
  return cachedPng(hash) || sanitizePng(bytes,hash);
}

export function readPublicPng(file) {
  const stat=fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Unavailable image');
  const stamp=`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const prior=pngFiles.get(file);
  if (prior?.stamp===stamp) { const cached=cachedPng(prior.hash); if(cached)return cached; }
  const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');
  const copy=cachedPng(hash) || sanitizePng(bytes,hash);
  if(pngFiles.size>=512)pngFiles.delete(pngFiles.keys().next().value);
  pngFiles.set(file,{stamp,hash});return copy;
}

export function containedPublicFile(root, file) {
  try {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && fs.statSync(file).isFile();
  } catch { return false; }
}

export function createPublicWorkspace(store, privacy, imageAliases = new Map()) {
  const reserved = 'private-files/';
  const publicPath = raw => {
    const rel = String(imageAliases.get(raw) || raw).replace(/\\/g, '/');
    return privacy.sensitivePath(rel) || rel.toLowerCase().startsWith(reserved)
      ? `${reserved}${neutralToken(rel, 'ERCraft')}${privacy.sensitivePath(path.posix.extname(rel)) ? '.bin' : path.posix.extname(rel).toLowerCase()}` : rel;
  };
  const index = () => {
    const entries = new Map();
    for (const meta of store.listFiles()) {
      if (!containedPublicFile(store.wsDir, store.abs(meta.path))) continue;
      const name = publicPath(meta.path);
      // A digest collision must never resolve to a different original.
      if (entries.has(name)) entries.set(name, null); else entries.set(name, meta);
    }
    return entries;
  };
  // Cache only public copies, bounded in memory; never write derived artifacts.
  const cache = new Map(); let cacheBytes = 0;
  const copyOf = meta => {
    const file = store.abs(meta.path), stat = fs.statSync(file);
    const ext = path.posix.extname(meta.path).toLowerCase();
    if (ext === '.png') {
      try { return { body: readPublicPng(file), type: 'image/png', image: true }; } catch { return null; }
    }
    const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const prior = cache.get(file);
    if (prior?.stamp === stamp) return prior.copy;
    let copy = null;
    try {
      if (stat.size > MAX_BYTES) throw new Error('Not found');
      const bytes = fs.readFileSync(file);
      if (PLAIN.has(ext) || SOURCE.has(ext)) {
        const original = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (['.js','.mjs','.ts','.py'].includes(ext)) throw new Error('Not found');
        if (SOURCE.has(ext) && !safePublicSource(original, privacy)) throw new Error('Not found');
        const text = PLAIN.has(ext) ? privacy.text(original) : original;
        copy = { body: Buffer.from(text), text, type: SOURCE_MIME[ext] || 'text/plain; charset=utf-8' };
      }
    } catch { /* Generic unavailability; no path, parser or provider diagnostics. */ }
    if (prior) { cacheBytes -= prior.copy?.body.length || 0; cache.delete(file); }
    const size = copy?.body.length || 0;
    if(size > COPY_CACHE_LIMIT)return copy;
    while (cache.size && (cacheBytes + size > COPY_CACHE_LIMIT || cache.size >= 300)) {
      const first = cache.keys().next().value;
      cacheBytes -= cache.get(first).copy?.body.length || 0; cache.delete(first);
    }
    cache.set(file, {stamp, copy}); cacheBytes += size;
    return copy;
  };
  const list = () => [...index()].filter(([,m]) => m).map(([name,m]) => {
    const copy = copyOf(m);
    const sticker = m.path.startsWith('stickers/');
    const stickerOwner = sticker ? privacy.project({ owner: m.path.split('/').length > 2 ? m.path.split('/')[1] : m.createdBy || m.by }).owner : undefined;
    return { ...privacy.project(m), path: name, size: copy?.body.length ?? null, available: !!copy, ...(sticker ? { sticker: true, stickerOwner } : {}), ...(!copy ? { unavailable: '공개 사본을 제공할 수 없습니다.' } : {}) };
  });
  const resolve = requested => {
    // Require the exact public name. Reject legacy aliases, alternate spellings,
    // backslashes and traversals instead of redirecting to an identifying path.
    if (typeof requested !== 'string' || requested !== store.safeRel(requested)) throw new Error('Not found');
    const meta = index().get(requested);
    if (!meta || !containedPublicFile(store.wsDir, store.abs(meta.path))) throw new Error('Not found');
    return meta;
  };
  const read = requested => {
    const meta = resolve(requested);
    const copy = copyOf(meta);
    if (!copy) throw new Error('Not found');
    const publicMeta = { ...privacy.project(meta), path: requested, available: true, ...(meta.path.startsWith('stickers/') ? { sticker: true } : {}) };
    const { body, type } = copy;
    if (copy.image) {
      publicMeta.size = body.length;
      return { body, type: 'image/png', value: { rel: requested, image: true, size: body.length, metadataRemoved: true, notice: PUBLIC_IMAGE_NOTICE, meta: publicMeta } };
    }
    publicMeta.size = body.length;
    return { body, type, value: { rel: requested, text: copy.text, meta: publicMeta } };
  };
  return Object.freeze({ publicPath, list, read, resolve });
}
