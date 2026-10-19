// Per-document image sharing. No persistent cache, cookies, storage or CDN changes.
import { appUrl } from './base-path.js';

export class SharedImageCache {
  constructor({ fetchImage = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(45000), redirect: 'error' });
    if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '')) throw Error('Image unavailable');
    const blob = await response.blob();
    if (blob.size > 32 * 1024 ** 2) throw Error('Image too large');
    return blob;
  }, makeUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url),
  maxIdleBytes = 24 * 1024 ** 2, concurrency = 4 } = {}) {
    Object.assign(this, { fetchImage, makeUrl, revokeUrl, maxIdleBytes, concurrency });
    this.entries = new Map(); this.queue = []; this.active = 0;
  }
  acquire(key) {
    let item = this.entries.get(key);
    if (!item) {
      item = { key, users: 0, size: 0, url: null, touched: Date.now() };
      item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
      this.entries.set(key, item); this.queue.push(item);
    }
    item.users++; item.touched = Date.now(); this.drain();
    let released = false;
    return { promise: item.promise, get started() { return !!item.started; }, invalidate: () => {
      if (this.entries.get(key) === item) this.entries.delete(key);
      item.invalid = true; this.retire(item);
    }, release: () => {
      if (released) return; released = true; item.users--; item.touched = Date.now(); this.retire(item); this.trim();
    } };
  }
  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      if (!item.users) {
        this.entries.delete(item.key); item.reject(Error('Image no longer visible')); continue;
      }
      this.active++; item.started = true;
      Promise.resolve().then(() => this.fetchImage(item.key)).then(blob => {
        item.size = blob.size; item.url = this.makeUrl(blob); item.resolve(item.url);
      }).catch(error => {
        if (this.entries.get(item.key) === item) this.entries.delete(item.key);
        item.reject(error);
      }).finally(() => { this.active--; this.retire(item); this.trim(); this.drain(); });
    }
  }
  retire(item) {
    if (item.invalid && !item.users && item.url) { this.revokeUrl(item.url); item.url = null; }
  }
  trim() {
    const idle = [...this.entries.values()].filter(item => item.url && !item.users).sort((a,b) => a.touched-b.touched);
    let bytes = idle.reduce((sum,item) => sum+item.size,0);
    for (const item of idle) {
      if (bytes <= this.maxIdleBytes && this.entries.size <= 100) break;
      this.entries.delete(item.key); this.revokeUrl(item.url); bytes -= item.size;
    }
  }
}

export function sharedImageUrl(value, origin = globalThis.location?.origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value)) return null;
  try {
    const url = new URL(value, origin);
    const base = appUrl('/');
    const relative = url.pathname.slice(base.length);
    if (url.origin !== origin || !url.pathname.startsWith(base)
      || !/^(?:assets\/characters\/(?:adina|eleven|bianca|lucia|dev|former-member)\/(?:avatar|full)\.png|ws\/[^?#]+\.(?:png|jpe?g|webp|gif|svg))$/i.test(relative)) return null;
    return url.pathname + url.search;
  } catch { return null; }
}

export function setSharedImage(img, url, { eager = false, feedback } = {}) {
  img.decoding = 'async';
  if (eager) img.dataset.sharedEager = 'true';
  else delete img.dataset.sharedEager;
  if (feedback !== undefined) img.dataset.sharedFeedback = String(feedback);
  img.dataset.sharedSrc = url;
}

const imageLabels = {
  ko: { waiting: '이미지 대기 중…', loading: '이미지를 불러오는 중…', failed: '이미지를 불러오지 못했어요.', unavailable: '사용할 수 없는 이미지예요.', retry: '다시 시도' },
  en: { waiting: 'Image waiting…', loading: 'Loading image…', failed: 'Could not load image.', unavailable: 'Image unavailable.', retry: 'Try again' },
  ja: { waiting: '画像を待機中…', loading: '画像を読み込み中…', failed: '画像を読み込めませんでした。', unavailable: '画像を利用できません。', retry: '再試行' },
};

export function observeSharedImages(root = document, { cache = new SharedImageCache() } = {}) {
  const bindings = new WeakMap(), mounted = new Set(), failures = new Map(), watched = new WeakSet();
  const doc = root.ownerDocument || root;
  const labels = imageLabels[doc.documentElement?.lang?.split('-')[0]] || imageLabels.ko;
  const current = (binding, lease = binding.lease) => bindings.get(binding.img) === binding
    && binding.img.isConnected && sharedImageUrl(binding.img.dataset.sharedSrc) === binding.url && binding.lease === lease;
  const state = (binding, value) => {
    binding.img.dataset.sharedState = value;
    if (!binding.status) return;
    binding.img.setAttribute('aria-busy', String(value === 'loading' || value === 'waiting'));
    binding.status.hidden = value === 'ready';
    binding.label.textContent = binding.compact ? (value === 'failed' || value === 'unavailable' ? '!' : '…') : (labels[value] || '');
    binding.status.setAttribute('aria-label', labels[value] || '');
    binding.status.title = labels[value] || '';
    if (binding.retry) binding.retry.hidden = value !== 'failed';
  };
  const release = binding => {
    // Clear the DOM reference before trim can revoke its object URL.
    binding.assigned = null; binding.img.removeAttribute('src');
    binding.lease?.release(); binding.lease = null;
  };
  const retry = binding => {
    if (!current(binding) || !(failures.get(binding.url)?.count >= 3)) return;
    failures.delete(binding.url);
    for (const other of mounted) {
      if (other.url !== binding.url) continue;
      clearTimeout(other.timer);
      state(other, other.visible ? 'loading' : 'waiting');
      load(other);
    }
  };
  const feedback = binding => {
    const mode = binding.img.dataset.sharedFeedback;
    if (mode !== 'true' && mode !== 'compact') return;
    binding.compact = mode === 'compact';
    const status = binding.status = doc.createElement('span');
    status.className = 'shared-image-status' + (binding.compact ? ' compact' : '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    binding.label = doc.createElement('span'); status.append(binding.label);
    if (!binding.compact) {
      const button = binding.retry = doc.createElement('button');
      button.type = 'button'; button.textContent = labels.retry; button.hidden = true;
      button.onclick = event => { event.preventDefault(); event.stopPropagation(); retry(binding); };
      status.append(button);
    }
    binding.img.after(status);
  };
  const load = binding => {
    if (!current(binding) || !binding.url || !binding.visible || binding.lease) return;
    clearTimeout(binding.timer);
    const failure = failures.get(binding.url);
    if (failure?.count >= 3) { state(binding, 'failed'); return; }
    state(binding, 'loading');
    if (failure?.retryAt > Date.now()) {
      binding.timer = setTimeout(() => load(binding), failure.retryAt - Date.now()); return;
    }
    const lease = binding.lease = cache.acquire(binding.url);
    // One budget per URL/revision, even across copies, hidden panels and remounts.
    if (!watched.has(lease.promise)) {
      watched.add(lease.promise);
      lease.promise.then(() => failures.delete(binding.url), () => {
        if (!lease.started) return; // A detached queued request was never a network attempt.
        const count = (failures.get(binding.url)?.count || 0) + 1;
        failures.set(binding.url, { count, retryAt: Date.now() + 1500 * count });
      });
    }
    lease.promise.then(src => {
      if (current(binding, lease)) {
        binding.assigned = src; binding.img.src = src;
        if (binding.img.complete && binding.img.naturalWidth) binding.loaded();
      }
    }).catch(() => {
      lease.release();
      if (!current(binding, lease)) return;
      binding.lease = null;
      load(binding);
    });
  };
  const visibility = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const binding = bindings.get(entry.target);
      if (!binding) continue;
      binding.visible = entry.isIntersecting;
      if (binding.visible) load(binding);
      else {
        clearTimeout(binding.timer); release(binding);
        state(binding, failures.get(binding.url)?.count >= 3 ? 'failed' : 'waiting');
      }
    }
  }, { rootMargin: '180px' }) : null;
  const forget = img => {
    const binding = bindings.get(img); if (!binding) return;
    visibility?.unobserve(img); clearTimeout(binding.timer); release(binding);
    img.removeEventListener('load', binding.loaded); img.removeEventListener('error', binding.broken);
    binding.status?.remove(); mounted.delete(binding); bindings.delete(img);
  };
  const bind = img => {
    const url = sharedImageUrl(img.dataset.sharedSrc);
    if (bindings.get(img)?.url === url) return;
    forget(img); img.removeAttribute('src');
    if (!img.isConnected) return;
    const eager = img.dataset.sharedEager === 'true' || !visibility;
    const binding = { img, url, lease: null, timer: null, visible: eager };
    binding.loaded = () => {
      if (!current(binding) || !binding.assigned || img.getAttribute('src') !== binding.assigned || !img.naturalWidth) return;
      // Preserve photo geometry while its offscreen Blob lease is released.
      if (img.dataset.sharedFeedback === 'true') { img.width = img.naturalWidth; img.height = img.naturalHeight; }
      state(binding, 'ready');
    };
    binding.broken = () => {
      if (!current(binding) || !binding.assigned || img.getAttribute('src') !== binding.assigned) return;
      const promise = binding.lease.promise;
      failures.set(url, { count: 3, retryAt: 0 }); binding.lease.invalidate();
      for (const other of mounted) {
        if (other.url !== url) continue;
        if (other.lease?.promise === promise) release(other);
        clearTimeout(other.timer); state(other, 'failed');
      }
    };
    bindings.set(img,binding); mounted.add(binding); feedback(binding);
    img.addEventListener('load', binding.loaded); img.addEventListener('error', binding.broken);
    state(binding, !url ? 'unavailable' : failures.get(url)?.count >= 3 ? 'failed' : 'waiting');
    if (!url) return;
    if (eager) load(binding);
    // Eager viewers still become idle when their panel/lightbox is hidden.
    visibility?.observe(img);
  };
  const walk = (node, fn) => {
    if (node.nodeType !== 1) return;
    if (node.matches('img[data-shared-src]')) fn(node);
    node.querySelectorAll('img[data-shared-src]').forEach(fn);
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') bind(record.target);
      else {
        record.removedNodes.forEach(node => walk(node, img => { if (!img.isConnected) forget(img); }));
        record.addedNodes.forEach(node => walk(node, bind));
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-shared-src'] });
  root.querySelectorAll('img[data-shared-src]').forEach(bind);
  return { cache, disconnect: () => { observer.disconnect(); visibility?.disconnect(); [...mounted].forEach(binding => forget(binding.img)); } };
}

if (typeof document !== 'undefined') observeSharedImages(document);
