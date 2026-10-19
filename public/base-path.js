// The HTML server injects chatroom-base and prefixes root-relative static
// href/src/action attributes. Modules use relative imports; dynamic URLs use this.
export function getBasePath(doc = globalThis.document) {
  const value = doc?.querySelector('meta[name="chatroom-base"]')?.getAttribute('content') ?? '';
  if (value === '' || value === '/') return '';
  if (!/^\/[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*\/?$/.test(value)) {
    throw new TypeError('Invalid application base path');
  }
  return value.replace(/\/$/, '');
}

// Accept only application-root paths, never an origin, protocol or traversal.
export function appUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || /[\\\u0000-\u0020\u007f]/.test(path)) throw new TypeError('Invalid application URL');
  const pathname = path.split(/[?#]/, 1)[0];
  for (const segment of pathname.split('/')) {
    const decoded = decodeURIComponent(segment);
    if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) {
      throw new TypeError('Invalid application URL');
    }
  }
  return getBasePath() + path;
}
