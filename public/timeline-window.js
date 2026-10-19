// Only mounted rows own DOM (and shared-image leases). The rest are data + heights.
export const RECENT_MESSAGES = 80;
export const HISTORY_PAGE = 60;
export const MAX_ROWS = 180;
export const LIVE_MESSAGES = 600;
export const MAX_PENDING = 200;

export function uniqueMessages(messages) {
  const byId = new Map();
  for (const m of messages || []) {
    if (!Number.isSafeInteger(m?.id) || m.id < 1) continue;
    byId.set(m.id, { ...byId.get(m.id), ...m });
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function rememberPending(pending, message) {
  if (!Number.isSafeInteger(message?.id) || message.id < 1) return;
  pending.set(message.id, { ...pending.get(message.id), ...message });
  if (pending.size > MAX_PENDING) pending.delete(Math.min(...pending.keys()));
}

export function recentSnapshot(messages, pending = new Map()) {
  return uniqueMessages([...messages.slice(-RECENT_MESSAGES), ...pending.values()])
    .filter(m => typeof m.from === 'string').slice(-RECENT_MESSAGES);
}

export function overlaps(a, b) {
  const ids = new Set(a.map(m => m.id));
  return b.some(m => ids.has(m.id));
}

export class TimelineWindow {
  constructor({ scroller, container, build, pinned, onScroll }) {
    Object.assign(this, { scroller, container, build, pinned, onScroll });
    this.items = []; this.heights = new Map(); this.nodes = new Map();
    this.prefix = [0]; this.dirty = new Set(); this.start = 0; this.end = 0;
    this.top = document.createElement('div'); this.bottom = document.createElement('div');
    for (const spacer of [this.top, this.bottom]) {
      spacer.className = 'timeline-spacer'; spacer.setAttribute('aria-hidden', 'true');
    }
    this.resize = new ResizeObserver(() => {
      // The saved anchor precedes layout changes, including decoded photos.
      this.render(this.anchor);
    });
    this.width = scroller.clientWidth;
    this.viewportResize = new ResizeObserver(() => {
      if (scroller.clientWidth !== this.width) {
        this.width = scroller.clientWidth; this.heights.clear(); this.reindex();
      }
      this.render(this.anchor);
    });
    this.viewportResize.observe(scroller);
    scroller.addEventListener('scroll', () => {
      const top = scroller.scrollTop;
      const internal = this.expectedTop != null && Math.abs(top - this.expectedTop) < 1;
      this.expectedTop = null;
      this.onScroll?.({ top, up: top < (this.lastTop ?? top), internal });
      this.lastTop = top;
      if (!internal) this.anchor = this.capture();
      this.schedule();
    }, { passive: true });
  }

  capture() {
    const edge = this.scroller.getBoundingClientRect().top;
    let partial = null;
    for (const [id, node] of this.nodes) {
      const rect = node.lastElementChild.getBoundingClientRect();
      if (rect.bottom > edge && rect.top < edge + this.scroller.clientHeight) {
        const anchor = { id, offset: rect.top - edge };
        if (rect.top >= edge) return anchor;
        partial ||= anchor;
      }
    }
    return partial;
  }

  reindex() {
    this.prefix = [0];
    this.indices = new Map();
    this.items.forEach((m, i) => {
      this.indices.set(m.id, i);
      this.prefix.push(this.prefix[i] + (this.heights.get(m.id) || 72));
    });
  }

  setItems(items, { reset = false, invalidate = false } = {}) {
    const anchor = this.capture();
    if (reset) this.heights.clear();
    this.items = items;
    const retained = new Set(items.map(m => m.id));
    for (const id of this.heights.keys()) if (!retained.has(id)) this.heights.delete(id);
    if (invalidate) for (const id of this.nodes.keys()) this.dirty.add(id);
    this.reindex();
    this.render(anchor);
  }

  invalidate(id) { this.dirty.add(id); this.schedule(); }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null; this.render(this.anchor);
    });
  }

  writeTop(value) {
    this.scroller.scrollTop = value;
    this.expectedTop = this.scroller.scrollTop;
    this.lastTop = this.expectedTop;
  }

  origin() {
    return this.container.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
  }

  atOffset(offset) {
    let lo = 0, hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.prefix[mid + 1] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, Math.max(0, this.items.length - 1));
  }

  render(anchor = this.capture(), target) {
    const n = this.items.length, pin = target == null && this.pinned();
    const anchorIndex = this.indices?.get(anchor?.id);
    const focus = target ?? (pin ? n - 1 : anchorIndex ?? this.atOffset(this.scroller.scrollTop - this.origin()));
    // A scrollbar jump may land entirely inside a spacer. Keep the estimated
    // target in view as that previously unmeasured range acquires real heights.
    if (!anchor && !pin && target == null && n) {
      anchor = { id: this.items[focus].id, offset: this.prefix[focus] + this.origin() - this.scroller.scrollTop };
    }
    const start = Math.max(0, Math.min(n - MAX_ROWS, focus - 60));
    const end = Math.min(n, start + MAX_ROWS);
    const next = new Map();
    for (let i = start; i < end; i++) {
      const m = this.items[i], prev = this.items[i - 1];
      let node = this.nodes.get(m.id);
      if (!node || node.prevId !== prev?.id || this.dirty.has(m.id)) {
        if (node) this.resize.unobserve(node);
        node = document.createElement('div'); node.className = 'timeline-item';
        node.dataset.messageId = m.id; node.prevId = prev?.id;
        node.append(this.build(m, prev, false));
        this.resize.observe(node);
      }
      next.set(m.id, node);
    }
    let changed = this.nodes.size !== next.size;
    for (const [id, node] of this.nodes) {
      if (next.get(id) !== node) { changed = true; this.resize.unobserve(node); }
    }
    this.nodes = next; this.start = start; this.end = end; this.dirty.clear();
    this.spacers();
    if (changed || !this.top.isConnected) this.container.replaceChildren(this.top, ...next.values(), this.bottom);
    let measured = false;
    for (const [id, node] of next) {
      const height = node.getBoundingClientRect().height;
      if (Math.abs((this.heights.get(id) || 0) - height) > 0.25) {
        this.heights.set(id, height); measured = true;
      }
    }
    if (measured) { this.reindex(); this.spacers(); }
    if (pin) this.writeTop(this.scroller.scrollHeight);
    else if (target != null) {
      const node = next.get(this.items[target]?.id);
      if (node) this.writeTop(this.scroller.scrollTop + node.getBoundingClientRect().top
        - this.scroller.getBoundingClientRect().top - this.scroller.clientHeight / 3);
    } else if (anchor && next.has(anchor.id)) {
      const delta = next.get(anchor.id).lastElementChild.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) > 0.25) this.writeTop(this.scroller.scrollTop + delta);
    }
    // Keep the same visible message across multi-phase image changes (src,
    // decode, feedback removal), until the reader actually scrolls again.
    const anchored = !pin && target == null ? next.get(anchor?.id) : null;
    const rect = anchored?.lastElementChild.getBoundingClientRect();
    const edge = this.scroller.getBoundingClientRect().top;
    this.anchor = rect && rect.bottom > edge && rect.top < edge + this.scroller.clientHeight
      ? { id: anchor.id, offset: rect.top - edge } : this.capture();
  }

  spacers() {
    this.top.style.height = `${this.prefix[this.start] || 0}px`;
    this.bottom.style.height = `${(this.prefix[this.items.length] || 0) - (this.prefix[this.end] || 0)}px`;
  }

  toBottom() { this.render(null); }

  jump(id) {
    const i = this.indices.get(id);
    if (i == null) return false;
    this.render(null, i);
    return true;
  }
}
