// Presentation only. Names, aliases, art paths and crops come from memberView via state/SSE.
import { t } from './i18n.js';
import { appUrl } from './base-path.js';
import './shared-images.js';

// The world has its own stylesheet. Keep the small shared avatar layout/state
// rules here so every consumer follows the cache's decoded-ready contract.
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
.persona-avatar { container-type: inline-size; }
.persona-avatar-initial { position: absolute; inset: 0; display: grid; place-items: center; background: var(--avatar-background, #eef1f6); color: var(--avatar-color, #555b66); font-size: 52cqi; font-weight: 750; line-height: 1; user-select: none; pointer-events: none; }
.persona-avatar > img:not([data-shared-state="ready"]) { visibility: hidden; }
.persona-avatar > img[data-shared-state="ready"] + .persona-avatar-initial { visibility: hidden; }
`;
  document.head.append(style);
}
const members = new Map();
const defaults = {
  // dev is absent from the scheduled memberView list; both chat and world use this presentation.
  dev: { name: t('dev.name'), color: '#0f766e',
    aliases: ['나쟈', '나쟈 박사', 'nadja', 'dr. nadja', 'ナジャ', 'ナジャ博士', '개발자', '개발 세션', '개발세션', '빌더', 'dev', 'developer', '開発者', 'デベロッパー'],
    persona: { skin: { full: '/assets/characters/dev/full.png', avatar: '/assets/characters/dev/full.png', avatarCrop: { x: 0.275, y: 0, width: 0.43, height: 0.1585 } } },
  },
  'former-member': { name: t('member.previous'), color: '#555b66' },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const norm = (s) => String(s).toLowerCase().replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
export function setPersonaMembers(list = []) {
  const before = JSON.stringify([...members.values()].map(identity));
  members.clear();
  for (const m of list) if (m && typeof m.id === 'string') members.set(m.id, m);
  return before !== JSON.stringify([...members.values()].map(identity));
}
function identity(m) { return [m.id, m.name, m.color, m.accentColor, m.aliases, m.persona]; }
export const memberName = (id) => members.get(id)?.name || defaults[id]?.name || id;
export const memberColor = (id) => members.get(id)?.color || defaults[id]?.color;
export const memberAccentColor = (id) => members.get(id)?.accentColor || memberColor(id);
export const aliasesFor = (id) => [...new Set([memberName(id), ...(members.get(id)?.aliases || []), ...(defaults[id]?.aliases || [])])];
export const personaSpec = (id) => members.get(id)?.persona || defaults[id]?.persona;
export function validCrop(c) {
  return c && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(c[k]))
    && c.x >= 0 && c.y >= 0 && c.width > 0 && c.height > 0
    && c.x + c.width <= 1 && c.y + c.height <= 1 ? c : null;
}
export function avatarSpec(id) {
  const p = personaSpec(id);
  if (p) {
    const src = p.skin?.avatar;
    const safe = typeof src === 'string' && src.startsWith(`/assets/characters/${id}/`) && /^\/assets\/characters\/(?:eleven|adina|lucia|bianca|former-member|dev)\/(?:full|avatar)\.png$/.test(src);
    return { src: safe ? appUrl(src) : '', crop: validCrop(p.skin?.avatarCrop) };
  }
  return { src: '', crop: null };
}
export function avatarMarkup(id, className = '', label = '') {
  const { src, crop } = avatarSpec(id);
  // Never derive a visible initial from a routing key, alias or caller's label.
  const name = members.get(id)?.name || defaults[id]?.name;
  const initial = typeof name === 'string' ? Array.from(name.trim())[0] || '?' : '?';
  const color = memberColor(id);
  const tint = /^(?:#[\da-f]{3}|#[\da-f]{6})$/i.test(color || '') ? color : '#555b66';
  const frame = `position:relative;display:inline-block;overflow:hidden;flex-shrink:0;vertical-align:middle;--avatar-color:${tint}`;
  const image = crop
    ? `width:${100 / crop.width}%;height:${100 / crop.height}%;left:${-100 * crop.x / crop.width}%;top:${-100 * crop.y / crop.height}%;object-fit:fill`
    : 'width:100%;height:100%;left:0;top:0;object-fit:cover';
  return `<span class="persona-avatar ${esc(className)}" style="${frame}"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}>${src ? `<img data-shared-src="${esc(src)}?preview=1" alt="" decoding="async" style="position:absolute;display:block;max-width:none;border-radius:0;${image}">` : ''}<span class="persona-avatar-initial" aria-hidden="true">${esc(initial)}</span></span>`;
}
export function createAvatar(id, className = '', label = '') {
  const template = document.createElement('template');
  template.innerHTML = avatarMarkup(id, className, label);
  return template.content.firstElementChild;
}
// One decoded source per URL; callers redraw only when identity metadata changes.
const images = new Map();
export function loadAvatarImage(id) {
  const { src } = avatarSpec(id);
  if (!src) return Promise.resolve(null);
  if (!images.has(src)) images.set(src, new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { images.delete(src); resolve(null); };
    img.src = src;
  }));
  return images.get(src);
}
export function drawAvatar(ctx, img, id, x, y, width, height) {
  const crop = avatarSpec(id).crop;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (crop) ctx.drawImage(img, crop.x * iw, crop.y * ih, crop.width * iw, crop.height * ih, x, y, width, height);
  else {
    const scale = Math.max(width / iw, height / ih), sw = width / scale, sh = height / scale;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, width, height);
  }
}
