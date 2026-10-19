// AI 단톡방 client: renders the room, streams updates over SSE, drives the composer
// and the shared-workspace panel. UI text comes from i18n.js (room language in <html lang>).

import { t, applyI18n, locale } from './i18n.js';
import { setPersonaMembers, memberName, memberColor, memberAccentColor, aliasesFor, norm, avatarMarkup, createAvatar } from './persona-client.js';
import { systemText, quotaLabel, quotaPlan, quotaNote, sessionView, sleepView } from './presentation.js';
import { appUrl } from './base-path.js';
import { createLiarPanel } from './liar-panel.js';
import { setSharedImage } from './shared-images.js';
import { TimelineWindow, RECENT_MESSAGES, HISTORY_PAGE, LIVE_MESSAGES, uniqueMessages, rememberPending, recentSnapshot, overlaps } from './timeline-window.js';

applyI18n();

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  reply: '<svg viewBox="0 0 24 24"><path d="M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  smile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 14a4.2 4.2 0 0 0 7 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9.3" cy="10" r="1.2" fill="currentColor"/><circle cx="14.7" cy="10" r="1.2" fill="currentColor"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const QUICK_EMOJI = ['👍', '😂', '❤️', '😮', '🤔', '🔥', '👀', '🙏'];
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
const AI_IDS = ['eleven', 'adina', 'lucia', 'bianca'];
const STATUSES = ['idle', 'reading', 'typing', 'away', 'sleeping', 'off', 'missing', 'error'];
const statusText = (st) => t(`status.${STATUSES.includes(st) ? st : 'idle'}`);

const S = {
  room: {}, members: {}, messages: [], byId: new Map(), files: [], notes: {}, usage: {},
  session: sessionView(null), sleeps: {}, liar: null,
  replyTo: null, openPath: null, tab: 'files', stuck: true, unseen: 0,
  freshFiles: new Set(), hadError: false, mention: null, pending: null, sending: false,
  tail: null, needsSnapshot: false,
};

const app = $('#app');
const tl = $('#timeline');
const msgsBox = $('#msgs');
const input = $('#input');
const isAdmin = () => S.session.role === 'admin' && S.session.authenticated;
let sessionEpoch = 0, stateLoad = 0, stream;
let pendingState = null;

// ---------------------------------------------------------------------------
// helpers

const extOf = (p) => (String(p).split('.').pop() || '').toLowerCase();
const wsUrl = (p, bust) => appUrl('/ws/' + String(p).split('/').map(encodeURIComponent).join('/') + (bust ? `?t=${bust}` : ''));
const fileRevision = file => file && `${file.mtime}-${file.size}-${file.available !== false}`;
const workspaceImageUrl = (p, { original = false } = {}) => {
  const file = S.files.find(f => f.path === p);
  if (file?.available === false) return '';
  const url = wsUrl(p, file && `${file.mtime}-${file.size}`);
  // Keep animated/vector images and transparent stickers in their original form.
  return !original && !file?.sticker && /\.(?:png|jpe?g|webp)$/i.test(p)
    ? `${url}${url.includes('?') ? '&' : '?'}preview=1` : url;
};
// The dev session, joined through the dev bridge, is a participant but not a scheduled AI.
const DEV = {
  id: 'dev', name: memberName('dev'), color: memberColor('dev'),
  aliases: aliasesFor('dev'),
};
function nameOf(id) {
  if (id === 'user') return 'ERCraft';
  if (id === 'system') return t('name.system');
  if (id === DEV.id) return DEV.name;
  return memberName(id);
}
function colorOf(id) {
  if (id === 'user') return 'var(--mine)';
  if (id === DEV.id) return DEV.color;
  return memberColor(id) || 'var(--muted)';
}
function setMemberColors(node, id) {
  const color = colorOf(id), accent = memberAccentColor(id) || color;
  node.style.setProperty('--c', color);
  node.style.setProperty('--accent-c', accent);
  node.classList.toggle('has-accent', accent !== color);
}
const liarPanel = createLiarPanel({ nameOf });
window.addEventListener('pagehide', (event) => { if (!event.persisted) liarPanel.dispose(); });
const devOnline = () => !!S.room.dev?.online;
function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}
function dayLabel(ts) {
  return new Date(ts).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return t('ago.now');
  if (s < 3600) return t('ago.min', { n: Math.round(s / 60) });
  if (s < 86400) return t('ago.hour', { n: Math.round(s / 3600) });
  return t('ago.day', { n: Math.round(s / 86400) });
}
const stickerName = (p) => String(p).split('/').pop().replace(/\.[^.]+$/, '');
const size = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);

function toast(text, ms = 2600) {
  const box = $('#toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, ms);
}

async function api(path, body, options = {}) {
  const authPath = path === '/api/admin/login' || path === '/api/admin/logout';
  if (body !== undefined && !authPath && !isAdmin()) {
    throw Object.assign(new Error(t('auth.required')), { status: 403 });
  }
  const res = await fetch(appUrl(path), body === undefined ? { cache: 'no-store', credentials: 'same-origin', ...options } : {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (!authPath && [401, 403].includes(res.status)) revokeSession();
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function renderAccess() {
  const admin = isAdmin();
  document.body.dataset.role = admin ? 'admin' : 'viewer';
  for (const node of document.querySelectorAll('[data-admin-only]')) node.hidden = !admin;
  for (const node of document.querySelectorAll('.settings button, .settings select')) node.disabled = !admin;
  for (const id of ['power', 'offbarOn']) $('#' + id).disabled = !admin;
  for (const id of ['send', 'attachBtn', 'stickerBtn', 'fileInput']) $('#' + id).disabled = !admin || S.sending;
  $('#power').title = admin ? '' : t('auth.powerHint');
  $('#powerAccess').title = admin ? '' : t('auth.powerHint');
  $('#powerAccess').tabIndex = admin ? -1 : 0;
  $('#powerAccess').setAttribute('aria-label', admin ? t('power.on') : t('auth.powerHint'));
  input.readOnly = !admin;
  input.placeholder = t(admin ? 'composer.placeholder' : 'auth.composer');
  $('#viewerHint').hidden = admin;
  $('#adminLogin').hidden = admin;
}

function applySession(value) {
  const wasAdmin = isAdmin();
  S.session = sessionView(value);
  sessionEpoch++;
  cancelHistory();
  if (isAdmin() && $('#loginDialog').open) $('#loginDialog').close();
  if (!isAdmin()) {
    // Public SSE updates must never retain private settings after expiry/logout.
    const { running, sleeping, roomName, userName, lang, dev } = S.room;
    S.room = { running, sleeping, roomName, userName, lang, dev };
    S.usage = {};
    input.value = '';
    clearReply(); clearAttach(); closeMention(); toggleStickerPop(false);
    $('#reactPop').hidden = true;
    $('#fileInput').value = '';
  }
  renderAccess();
  if (wasAdmin !== isAdmin()) {
    renderAllMessages();
    renderMembers();
  }
}

function revokeSession() {
  stateLoad++; // Ignore an older admin /state response arriving after revocation.
  applySession(null);
}

async function refreshSession() {
  revokeSession();
  try { await load({ recoverHistory: true }); } catch { toast(t('auth.refreshFailed')); }
}

async function changeRoom(body) {
  const epoch = sessionEpoch;
  try {
    const room = await api('/api/room', body);
    if (isAdmin() && epoch === sessionEpoch) { S.room = { ...S.room, ...room }; renderRoom(); }
  } catch { renderRoom(); toast(t('toast.changeFailed')); }
}

function openLogin() {
  if (isAdmin()) return;
  $('#loginError').hidden = true;
  $('#adminPassword').value = '';
  if (!$('#loginDialog').open) $('#loginDialog').showModal();
  $('#adminPassword').focus();
}
$('#adminLogin').onclick = (e) => { e.preventDefault(); openLogin(); };
$('#loginClose').onclick = () => $('#loginDialog').close();
$('#loginDialog').addEventListener('close', () => { $('#adminPassword').value = ''; });
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('#loginSubmit').disabled) return;
  const password = $('#adminPassword').value;
  if (!password) return;
  $('#adminPassword').value = '';
  $('#loginSubmit').disabled = true;
  $('#loginError').hidden = true;
  try {
    await api('/api/admin/login', { password });
    await load();
    if (!isAdmin()) throw new Error('session_unconfirmed');
    connect(); // Establish the new HttpOnly-cookie session for expiry events.
    $('#loginDialog').close();
    toast(t('auth.loggedIn'));
  } catch (error) {
    $('#loginError').textContent = t(error.status === 429 ? 'auth.tooMany' : error.status === 401 || error.status === 403 ? 'auth.invalid' : 'auth.loginFailed');
    $('#loginError').hidden = false;
    $('#adminPassword').focus();
  } finally {
    $('#adminPassword').value = '';
    $('#loginSubmit').disabled = false;
  }
};
$('#adminLogout').onclick = async () => {
  $('#adminLogout').disabled = true;
  try {
    await api('/api/admin/logout', {});
    revokeSession();
    connect();
    await load();
    toast(t('auth.loggedOut'));
  } catch { toast(t('auth.logoutFailed')); }
  finally { $('#adminLogout').disabled = false; }
};

// Who does the word after "@" call? Japanese (and Korean) put particles right after a name
// ("@イレブンさん", "@일레븐아"), so the longest name at the start of the word wins; a Latin
// name must not run on into more Latin letters ("@device" is not "@dev").
function mentionHit(word) {
  const cands = [];
  for (const id of AI_IDS) for (const a of aliasesFor(id)) cands.push([norm(a), colorOf(id)]);
  cands.push([norm(nameOf('user')), 'var(--mine)']);
  for (const a of [...DEV.aliases, DEV.name]) cands.push([norm(a), DEV.color]);
  let best = null;
  for (const [a, color] of cands) {
    if (!a || (best && a.length <= best.len) || norm(word.slice(0, a.length)) !== a) continue;
    if (/[a-z0-9_]$/.test(a) && /^[A-Za-z0-9_]/.test(word.slice(a.length))) continue;
    best = { len: a.length, color };
  }
  return best;
}

// ---------------------------------------------------------------------------
// text rendering

function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // Any script: Latin, Hangul, kana, kanji.
  h = h.replace(/@([\p{L}\p{N}_]+)/gu, (m, word) => {
    const hit = mentionHit(word);
    if (!hit) return m;
    return `<span class="mention" style="--c:${hit.color}">@${word.slice(0, hit.len)}</span>${word.slice(hit.len)}`;
  });
  return h.replace(/\n/g, '<br>');
}

function renderText(text) {
  return String(text).split('```').map((part, i) => (i % 2
    ? `<pre>${esc(part.replace(/^[\w+-]*\n/, ''))}</pre>`
    : inline(part.replace(/^\n+|\n+$/g, '')))).join('');
}

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${mdInline(para.join('\n'))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flush(); const n = Math.min(m[1].length, 3); out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${mdInline(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const buf = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${buf.map((b) => `<li>${mdInline(b)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}
function mdInline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return h.replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------------------
// messages

function snippet(m) {
  if (m.text) return systemText(m, m.by ? nameOf(m.by) : '', t).replace(/\s+/g, ' ').slice(0, 90);
  if (m.attach?.sticker) return t('snippet.sticker', { name: stickerName(m.attach.path) });
  if (m.attach) return m.attach.upload ? t('snippet.photo') : t('snippet.attach', { path: m.attach.path });
  return '';
}

function buildQuote(id) {
  const q = S.byId.get(id);
  const b = el('button', 'quote');
  b.type = 'button';
  if (q) {
    setMemberColors(b, q.from);
    b.innerHTML = `<span class="qn">${esc(nameOf(q.from))}</span>${esc(snippet(q))}`;
  } else {
    b.textContent = t('quote.missing', { id });
  }
  b.onclick = () => jumpTo(id);
  return b;
}

// Workspace pages run in a sandbox. The server's CSP header (`sandbox allow-scripts`, no network)
// already gives them an opaque origin, so allow-same-origin here does not let them reach this
// page; embedded desktop browsers require it to load the frame.
const WS_FRAME_SANDBOX = 'allow-scripts allow-same-origin';

// Shared description accompanying an attached photo.
function descCap(desc) {
  const cap = el('div', 'att-cap att-desc');
  cap.textContent = t('desc.cap', { desc: desc.length > 140 ? desc.slice(0, 140) + '…' : desc });
  cap.title = `${t('desc.titleGeneric')}\n\n${desc}`;
  return cap;
}

function buildAttach(a) {
  const e = extOf(a.path);
  const url = workspaceImageUrl(a.path);
  if (a.sticker && IMG_EXT.includes(e)) {
    const img = el('img', 'att-sticker');
    setSharedImage(img, url);
    img.dataset.workspaceImage = a.path;
    img.alt = stickerName(a.path);
    img.title = a.path;
    img.loading = 'lazy';
    img.onclick = () => lightbox(workspaceImageUrl(a.path, { original: true }), a.path, a.path);
    return img;
  }
  if (IMG_EXT.includes(e)) {
    const wrap = el('div', 'att-img-wrap');
    const img = el('img', `att-img${e === 'svg' ? ' svg' : ''}`);
    setSharedImage(img, url, { feedback: true });
    img.dataset.workspaceImage = a.path;
    img.alt = a.prompt || a.path;
    img.loading = 'lazy';
    img.onclick = () => lightbox(workspaceImageUrl(a.path, { original: true }), a.prompt ? `🎨 ${a.prompt}` : a.path, a.path);
    wrap.append(img);
    if (a.prompt) {
      const cap = el('div', 'att-cap');
      cap.textContent = `🎨 ${a.prompt.length > 140 ? a.prompt.slice(0, 140) + '…' : a.prompt}`;
      cap.title = a.prompt;
      wrap.append(cap);
    }
    if (a.desc) wrap.append(descCap(a.desc));
    return wrap;
  }
  if (e === 'html' || e === 'htm') {
    const box = el('div', 'att-html');
    const f = el('iframe');
    f.setAttribute('sandbox', WS_FRAME_SANDBOX);
    f.loading = 'lazy';
    f.title = a.path;
    f.src = url;
    const bar = el('div', 'att-bar', `<span class="p">${esc(a.path)}</span>`);
    const btn = el('button', '', esc(t('attach.expand')));
    btn.type = 'button';
    btn.onclick = () => openFile(a.path);
    bar.append(btn);
    box.append(f, bar);
    return box;
  }
  const b = el('button', 'att-file', `<span class="ic">${esc(e.toUpperCase().slice(0, 4))}</span><span class="p">${esc(a.path)}</span>`);
  b.type = 'button';
  b.onclick = () => openFile(a.path);
  return b;
}

function buildTools(m) {
  const bar = el('div', 'tools');
  if (!isAdmin()) { bar.hidden = true; return bar; }
  const r = el('button', '', ICON.reply);
  r.type = 'button';
  r.title = t('tools.reply');
  r.setAttribute('aria-label', t('tools.reply'));
  r.onclick = () => setReply(m.id);
  const e = el('button', '', ICON.smile);
  e.type = 'button';
  e.title = t('tools.react');
  e.setAttribute('aria-label', t('tools.reactAria'));
  e.onclick = (ev) => openReactPop(m.id, ev.currentTarget);
  bar.append(r, e);
  return bar;
}

function buildReacts(m) {
  const box = el('div', 'reacts');
  box.dataset.for = m.id;
  for (const [emo, list] of Object.entries(m.reactions || {})) {
    if (!list.length) continue;
    const c = el('button', `chip${isAdmin() && list.includes('user') ? ' me' : ''}`, `${esc(emo)} <b>${list.length}</b>`);
    c.type = 'button';
    c.title = list.map(nameOf).join(t('list.sep'));
    c.disabled = !isAdmin();
    if (isAdmin()) c.onclick = () => sendReact(m.id, emo);
    box.append(c);
  }
  return box;
}

function buildSys(m, animate) {
  const d = el('div', `sys k-${m.kind || 'info'}${animate ? ' new' : ''}`);
  d.id = `m${m.id}`;
  const text = systemText(m, m.by ? nameOf(m.by) : '', t);
  if (m.by) {
    d.style.setProperty('--c', colorOf(m.by));
    const n = nameOf(m.by);
    const at = text.indexOf(n);
    d.innerHTML = at >= 0
      ? `${esc(text.slice(0, at))}<span class="who">${esc(n)}</span>${esc(text.slice(at + n.length))}`
      : esc(text);
  } else {
    d.textContent = text;
  }
  if (m.kind === 'file' && m.file) {
    d.title = t('sys.openInWs');
    d.onclick = () => openFile(m.file);
  }
  return d;
}

function buildMsg(m, prev, animate) {
  const frag = document.createDocumentFragment();
  if (!prev || !sameDay(prev.ts, m.ts)) frag.append(el('div', 'day', esc(dayLabel(m.ts))));
  if (m.from === 'system') {
    frag.append(buildSys(m, animate));
    return frag;
  }
  const cont = prev && prev.from === m.from && m.ts - prev.ts < 180000 && sameDay(prev.ts, m.ts)
    && !!prev.deep === !!m.deep;
  const mine = m.from === 'user' && isAdmin();
  const row = el('div', `msg${mine ? ' mine' : ''}${cont ? ' cont' : ''}${animate ? ' new' : ''}`);
  row.id = `m${m.id}`;
  setMemberColors(row, m.from);
  if (!mine) {
    const av = createAvatar(m.from, 'm-av', nameOf(m.from));
    if (isAdmin()) {
      av.title = t('msg.mention', { name: nameOf(m.from) });
      av.onclick = () => insertMention(m.from);
    }
    row.append(av);
  }
  const body = el('div', 'm-body');
  if (!mine && !cont) {
    body.append(el('div', 'm-head', `<span class="n">${esc(nameOf(m.from))}</span>${m.deep ? `<span class="deep-badge" title="${esc(t('boost.name'))}">${esc(t('boost.badge'))}</span>` : ''}`));
  }
  if (m.deep) row.classList.add('deep');
  const line = el('div', 'line');
  const bubble = el('div', 'bubble');
  if (m.replyTo) bubble.append(buildQuote(m.replyTo));
  if (m.text) bubble.append(el('div', 'text', renderText(m.text)));
  if (m.attach) {
    bubble.append(buildAttach(m.attach));
    if (!m.text && !m.replyTo) bubble.classList.add('media');
  }
  line.append(bubble, el('span', 'time', esc(timeLabel(m.ts))), buildTools(m));
  body.append(line, buildReacts(m));
  row.append(body);
  frag.append(row);
  if (cont && timeLabel(prev.ts) === timeLabel(m.ts)) {
    document.getElementById(`m${prev.id}`)?.querySelector('.time')?.classList.add('dim');
  }
  return frag;
}

const timelineText = {
  ko: { loading: '이전 대화를 불러오는 중…', retry: '불러오지 못했어요 · 다시 시도', start: '대화의 시작', latest: '최근 대화로 이동 ↓', gap: '연결이 복구되었어요. 최근 대화로 이동해 이어서 볼 수 있어요.' },
  en: { loading: 'Loading earlier messages…', retry: 'Could not load · Try again', start: 'Start of conversation', latest: 'Jump to latest ↓', gap: 'Connection restored. Jump to the latest conversation to continue.' },
  ja: { loading: '以前の会話を読み込み中…', retry: '読み込めませんでした · 再試行', start: '会話の始まり', latest: '最新の会話へ ↓', gap: '接続が復旧しました。最新の会話へ移動できます。' },
}[locale.split('-')[0]] || { loading: 'Loading…', retry: 'Try again', start: 'Start of conversation', latest: 'Jump to latest ↓', gap: 'Connection restored. Jump to latest.' };
const history = { token: 0, busy: false, more: true, error: false, armed: true, controller: null };
const timeline = new TimelineWindow({
  scroller: tl, container: msgsBox, build: buildMsg, pinned: () => S.stuck && !S.tail,
  onScroll: ({ top, up, internal }) => {
    if (internal) return;
    // Even a single wheel notch upward is an explicit choice to read history.
    // Rejoin live following only after the reader reaches the actual bottom.
    S.stuck = !S.tail && !up && tl.scrollHeight - top - tl.clientHeight <= 2;
    if (S.stuck) {
      S.unseen = 0;
      if (S.messages.length > LIVE_MESSAGES) { pruneLiveMessages(); scheduleMessages(); }
    }
    renderJump();
    if (top > 180) history.armed = true;
    if (up && top < 100 && history.armed && !history.error) loadOlder();
  },
});
let messageFrame;
function scheduleMessages() {
  if (messageFrame) return;
  messageFrame = requestAnimationFrame(() => {
    messageFrame = null;
    timeline.setItems(S.messages.slice());
  });
}
function renderAllMessages() {
  timeline.setItems(S.messages.slice(), { invalidate: true });
  renderHistory();
}
function renderHistory() {
  const button = $('#loadMore');
  button.hidden = !S.messages.length;
  button.disabled = history.busy || !history.more;
  button.setAttribute('aria-busy', String(history.busy));
  button.textContent = history.busy ? timelineText.loading : history.error ? timelineText.retry
    : history.more ? t('chat.loadMore') : timelineText.start;
}
function renderJump() {
  const j = $('#jump');
  j.hidden = !S.needsSnapshot && !S.tail && !S.unseen && S.stuck;
  j.textContent = S.tail || S.needsSnapshot ? timelineText.latest : S.unseen ? t('chat.jumpN', { n: S.unseen }) : t('chat.jump');
  j.title = S.tail || S.needsSnapshot ? timelineText.gap : '';
}
function reindexMessages() {
  S.byId = new Map([...S.messages, ...(S.tail || [])].map(m => [m.id, m]));
}
function pruneLiveMessages() {
  if (S.messages.length <= LIVE_MESSAGES) return;
  const removed = S.messages.splice(0, S.messages.length - LIVE_MESSAGES);
  for (const m of removed) S.byId.delete(m.id);
  history.more = true;
}
function addMessage(m) {
  if (!Number.isSafeInteger(m?.id) || S.byId.has(m.id)) return;
  if (S.tail || S.needsSnapshot) {
    S.tail = uniqueMessages([...(S.tail || []), m]).slice(-RECENT_MESSAGES);
    reindexMessages();
  } else {
    // SSE ids increase; an older duplicate/out-of-order event must not reorder DOM.
    if (S.messages.length && m.id < S.messages.at(-1).id) {
      S.messages = uniqueMessages([...S.messages, m]);
    } else S.messages.push(m);
    S.byId.set(m.id, m);
    if (S.stuck) pruneLiveMessages();
    scheduleMessages();
  }
  if (!S.stuck || S.tail) S.unseen++;
  renderJump();
  if ((m.kind === 'file' || m.attach) && !wsVisible()) $('#wsBadge').hidden = false;
}
function updateMessage(m) {
  const old = S.byId.get(m.id);
  if (!old) return;
  if (m.reactions !== undefined) old.reactions = m.reactions;
  if (m.attach) old.attach = { ...old.attach, ...m.attach };
  // Rebuild only a mounted row. Offscreen updates stay in lightweight data.
  timeline.invalidate(m.id);
}
function toBottom() {
  if (S.needsSnapshot) {
    if (!pendingState) load({ recoverHistory: true }).then(() => { if (!S.needsSnapshot) toBottom(); })
      .catch(() => toast(t('toast.noServer')));
    return;
  }
  if (S.tail) {
    cancelHistory();
    S.messages = S.tail; S.tail = null; reindexMessages();
    history.more = S.messages.length > 0 && S.messages[0].id > 1;
    history.error = false; history.armed = true;
  }
  S.stuck = true; S.unseen = 0;
  pruneLiveMessages();
  timeline.setItems(S.messages.slice());
  timeline.toBottom(); renderHistory(); renderJump();
}
$('#jump').onclick = toBottom;

function jumpTo(id) {
  if (S.tail?.some(m => m.id === id)) toBottom();
  S.stuck = false;
  if (!timeline.jump(id)) { toast(t('toast.oldMessage')); return; }
  renderJump();
  const row = document.getElementById(`m${id}`);
  row?.classList.add('hl');
  setTimeout(() => row?.classList.remove('hl'), 1600);
}
function cancelHistory() {
  history.token++; history.controller?.abort(); history.controller = null;
  history.busy = false; renderHistory();
}
async function loadOlder() {
  if (history.busy || !history.more || pendingState) return;
  const first = S.messages[0];
  if (!first) return;
  const token = ++history.token, epoch = sessionEpoch, version = stateLoad;
  history.busy = true; history.error = false; history.armed = false;
  const controller = history.controller = new AbortController();
  renderHistory();
  try {
    const result = await api(`/api/history?before=${first.id}&limit=${HISTORY_PAGE}`, undefined, { signal: controller.signal });
    if (token !== history.token || epoch !== sessionEpoch || version !== stateLoad) return;
    const page = uniqueMessages(result.messages).filter(m => m.id < first.id && !S.byId.has(m.id)).slice(-HISTORY_PAGE);
    history.more = page.length === HISTORY_PAGE && page[0].id > 1;
    S.messages = page.concat(S.messages); reindexMessages();
    timeline.setItems(S.messages.slice());
  } catch (error) {
    if (token === history.token && error.name !== 'AbortError') history.error = true;
  } finally {
    if (token === history.token) { history.busy = false; history.controller = null; renderHistory(); }
  }
}
$('#loadMore').onclick = () => { S.stuck = false; loadOlder(); };

// ---------------------------------------------------------------------------
// members, room, typing

function setMembers(list) {
  const changed = setPersonaMembers(list);
  S.members = Object.fromEntries(list.map((m) => [m.id, m]));
  renderMembers();
  renderTyping();
  renderHead();
  if (changed) {
    liarPanel.update(S.liar);
    renderAllMessages();
    if (S.tab === 'notes' && wsVisible()) renderNotes();
    if (S.tab === 'usage' && wsVisible()) renderUsage();
  }
}

function renderMembers() {
  $('#brandAvatars').innerHTML = AI_IDS.filter((id) => S.members[id]).map((id) => avatarMarkup(id)).join('');
  const ul = $('#members');
  ul.innerHTML = '';
  for (const id of AI_IDS) {
    const m = S.members[id];
    if (!m) continue;
    const li = el('li', `member st-${STATUSES.includes(m.status) ? m.status : 'idle'}${m.drawing ? ' drawing' : ''}`);
    setMemberColors(li, id);
    let status = statusText(m.status);
    if (m.deep && m.status === 'reading') status = t('status.deepReading');
    if (m.drawing) status = m.status === 'typing' ? t('status.typingDrawing') : t('status.drawing');
    if (m.deep) li.classList.add('deep');
    li.title = m.name;
    li.innerHTML = `
      <div class="av-wrap">${avatarMarkup(id, 'av')}<span class="st-dot"></span></div>
      <div class="m-info">
        <div class="m-name"><span class="n">${esc(m.name)}</span></div>
        <div class="m-status">${esc(status)}</div>
      </div>`;
    // The sleep badge already describes inactive states; avoid a duplicate line.
    if (!m.drawing && ['off', 'away', 'sleeping'].includes(m.status)) li.querySelector('.m-status').hidden = true;
    li.querySelector('.m-info').append(memberSleep(id));
    if (isAdmin()) {
      const sw = el('label', 'switch');
      sw.title = m.enabled ? t('member.remove') : t('member.bringBack');
      sw.innerHTML = `<input type="checkbox" ${m.enabled ? 'checked' : ''} ${m.available ? '' : 'disabled'} aria-label="${esc(t('member.toggleAria', { name: m.name }))}"><span></span>`;
      sw.querySelector('input').onchange = (e) => api('/api/member', { id, enabled: e.target.checked }).catch(() => { renderMembers(); toast(t('toast.changeFailed')); });
      li.append(sw);
    }
    ul.append(li);
  }
  const dev = el('li', `member dev st-${devOnline() ? 'idle' : 'off'}`);
  dev.style.setProperty('--c', DEV.color);
  dev.title = t('dev.tooltip');
  dev.innerHTML = `
    <div class="av-wrap">${avatarMarkup(DEV.id, 'av')}<span class="st-dot"></span></div>
    <div class="m-info">
      <div class="m-name"><span class="n">${esc(DEV.name)}</span><span class="m-tag">${esc(t('dev.sub'))}</span></div>
      <div class="m-status">${esc(devOnline() ? t('dev.online') : t('dev.offline'))}</div>
    </div>`;
  ul.append(dev);
  const on = AI_IDS.filter((id) => S.members[id]?.enabled).length + (devOnline() ? 1 : 0);
  $('#memberCount').textContent = `· ${on + 1}`;
}

function renderTyping() {
  const box = $('#typing');
  box.innerHTML = '';
  if (!S.room.running) return;
  const typing = AI_IDS.filter((id) => S.members[id]?.status === 'typing');
  const drawing = AI_IDS.filter((id) => S.members[id]?.drawing);
  const reading = AI_IDS.filter((id) => S.members[id]?.status === 'reading');
  const group = (ids, key, cls) => {
    if (!ids.length) return;
    const g = el('span', `t ${cls}`);
    const names = ids.map((id) => `<b style="--c:${colorOf(id)}">${esc(nameOf(id))}</b>`).join(t('list.sep'));
    g.innerHTML = ids.map((id) => avatarMarkup(id)).join('')
      + t(key, { names, n: ids.length })
      + ' <span class="dots"><i></i><i></i><i></i></span>';
    box.append(g);
  };
  group(typing, 'typing.typing', 'typing');
  group(drawing, 'typing.drawing', 'drawing');
  group(reading.filter((id) => S.members[id]?.deep), 'typing.deep', 'deep');
  group(reading.filter((id) => !S.members[id]?.deep), 'typing.reading', 'reading');
}

function renderRoom() {
  const r = S.room;
  app.classList.toggle('running', !!r.running);
  app.classList.toggle('sleeping', !r.running && !!r.sleeping);
  const roomName = t('app.title');
  $('#roomName').textContent = roomName;
  $('#headTitle').textContent = roomName;
  document.title = roomName;
  $('#roomSub').textContent = t(r.running ? 'room.on' : r.sleeping ? 'room.sleeping' : 'room.off');
  $('#power').setAttribute('aria-pressed', r.running ? 'true' : 'false');
  $('.power-label').textContent = t(r.running ? 'power.stop' : r.sleeping ? 'power.wake' : 'power.on');
  for (const b of document.querySelectorAll('#speed button')) b.classList.toggle('on', b.dataset.v === r.speed);
  $('#autosleep').value = String(r.autoSleepMin ?? 30);
  if (Number.isFinite(r.autoSleepMin) && ![...$('#autosleep').options].some((o) => o.value === String(r.autoSleepMin))) {
    $('#autosleep').append(new Option(t('autosleep.min', { n: r.autoSleepMin }), String(r.autoSleepMin)));
    $('#autosleep').value = String(r.autoSleepMin);
  }
  for (const b of document.querySelectorAll('#boostMode button')) b.classList.toggle('on', b.dataset.v === (r.boostMode || 'auto'));
  const bm = ['auto', 'manual', 'off'].includes(r.boostMode) ? r.boostMode : 'auto';
  $('#boostHint').textContent = t(`boost.hint.${bm}`);
  $('#stat').textContent = '';
  $('#stat').hidden = true;
  $('#meName').textContent = nameOf('user');
  $('#meAv').textContent = nameOf('user').slice(0, 1);
  const off = !r.running;
  $('#offbar').hidden = !off;
  $('#offbarText').textContent = t(r.sleeping ? 'offbar.sleeping' : 'offbar.off');
  $('#offbarOn').textContent = t(r.sleeping ? 'power.wake' : 'power.on');
  renderTyping();
  renderHead();
  renderMembers();
  renderAccess();
}

function renderHead() {
  const on = AI_IDS.filter((id) => S.members[id]?.enabled).map(nameOf);
  if (devOnline()) on.push(DEV.name);
  $('#headSub').textContent = [...on, nameOf('user')].join(t('list.sep'));
  $('#devChip').hidden = !devOnline();
}

$('#power').onclick = () => changeRoom({ running: !S.room.running });
$('#offbarOn').onclick = () => changeRoom({ running: true });
for (const b of document.querySelectorAll('#speed button')) {
  b.onclick = () => changeRoom({ speed: b.dataset.v });
}
for (const b of document.querySelectorAll('#boostMode button')) {
  b.onclick = () => changeRoom({ boostMode: b.dataset.v });
}
$('#autosleep').onchange = (e) => changeRoom({ autoSleepMin: Number(e.target.value) });
for (const o of $('#autosleep').options) {
  const n = Number(o.value);
  if (n) o.textContent = n % 60 ? t('autosleep.min', { n }) : t('autosleep.hour', { n: n / 60 });
}

// ---------------------------------------------------------------------------
// reactions

function openReactPop(id, anchor) {
  if (!isAdmin()) return;
  const pop = $('#reactPop');
  pop.innerHTML = '';
  for (const e of QUICK_EMOJI) {
    const b = el('button', '', e);
    b.type = 'button';
    b.onclick = () => { sendReact(id, e); pop.hidden = true; };
    pop.append(b);
  }
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left - w / 2))}px`;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 6)}px`;
}
document.addEventListener('pointerdown', (e) => {
  const pop = $('#reactPop');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.tools')) pop.hidden = true;
});
function sendReact(id, emoji) {
  if (!isAdmin()) return;
  api('/api/react', { id, emoji }).catch(() => toast(t('toast.reactFailed')));
}

// ---------------------------------------------------------------------------
// composer

function setReply(id) {
  if (!isAdmin()) return;
  S.replyTo = id;
  const m = S.byId.get(id);
  const chip = $('#replyChip');
  if (!m) { chip.hidden = true; S.replyTo = null; return; }
  setMemberColors(chip, m.from);
  chip.innerHTML = `<span class="q">${t('reply.to', { name: esc(nameOf(m.from)), text: esc(snippet(m)) })}</span>`;
  const x = el('button', '', ICON.x);
  x.type = 'button';
  x.setAttribute('aria-label', t('reply.cancel'));
  x.onclick = clearReply;
  chip.append(x);
  chip.hidden = false;
  input.focus();
}
function clearReply() {
  S.replyTo = null;
  $('#replyChip').hidden = true;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

// ---- photo attachment: one image per message, sent with the text as base64 ----

const UPLOAD_MAX = 2 * 1024 * 1024;
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Re-encode a still image that is over the limit: smaller sides, then lower quality.
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
  try {
    for (const side of [2560, 2048, 1600, 1280]) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      canvas.width = Math.round(bmp.width * k);
      canvas.height = Math.round(bmp.height * k);
      const ctx = canvas.getContext('2d');
      if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      for (const q of [0.88, 0.78]) {
        const blob = await new Promise((r) => canvas.toBlob(r, type, q));
        if (blob && blob.size <= UPLOAD_MAX) return blob;
      }
    }
  } finally {
    bmp.close();
  }
  return null;
}

async function pickImage(file) {
  if (!isAdmin() || !file) return;
  const epoch = sessionEpoch;
  if (!UPLOAD_TYPES.includes(file.type)) { toast(t('upload.types')); return; }
  let blob = file;
  let shrunk = false;
  if (file.size > UPLOAD_MAX) {
    if (file.type === 'image/gif') { toast(t('upload.gifMax')); return; }
    try { blob = await shrinkImage(file); } catch { blob = null; }
    if (!blob) { toast(t('upload.shrinkFailed'), 3600); return; }
    shrunk = true;
  }
  clearAttach();
  const data = await readAsDataUrl(blob);
  if (!isAdmin() || epoch !== sessionEpoch) return;
  S.pending = { name: file.name || t('upload.pastedName'), size: blob.size, data, url: URL.createObjectURL(blob), shrunk, orig: file.size };
  renderAttach();
  input.focus();
}

function renderAttach() {
  const chip = $('#attachChip');
  const p = S.pending;
  if (!p) { chip.hidden = true; chip.innerHTML = ''; return; }
  chip.innerHTML = `<img src="${p.url}" alt=""><span class="q"><b>${esc(p.name)}</b> · ${size(p.size)}${p.shrunk ? ` ${esc(t('attach.shrunk', { size: size(p.orig) }))}` : ''}</span>`;
  const x = el('button', '', ICON.x);
  x.type = 'button';
  x.setAttribute('aria-label', t('attach.cancel'));
  x.onclick = () => { clearAttach(); input.focus(); };
  chip.append(x);
  chip.hidden = false;
}
function clearAttach() {
  if (S.pending?.url) URL.revokeObjectURL(S.pending.url);
  S.pending = null;
  renderAttach();
}

$('#attachBtn').onclick = () => { if (isAdmin()) $('#fileInput').click(); };
$('#fileInput').onchange = (e) => {
  pickImage(e.target.files[0]);
  e.target.value = '';
};
input.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  pickImage(file);
});
{
  const box = $('.composer');
  const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  box.addEventListener('dragover', (e) => { if (!hasFile(e)) return; e.preventDefault(); if (isAdmin()) box.classList.add('dragover'); });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('dragover'); });
  box.addEventListener('drop', (e) => {
    box.classList.remove('dragover');
    if (!hasFile(e)) return;
    e.preventDefault();
    pickImage([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')) || e.dataTransfer.files[0]);
  });
}

// ---- stickers: the owner's picker (images under stickers/<member>/ in the workspace) ----

const STICKER_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

function renderStickerPop() {
  const pop = $('#stickerPop');
  const list = S.files.filter((f) => f.sticker === true && f.available !== false && STICKER_EXT.includes(extOf(f.path)))
    .sort((a, b) => a.path.localeCompare(b.path));
  pop.innerHTML = '';
  if (!list.length) {
    pop.append(el('div', 'sticker-empty', esc(t('sticker.empty'))));
    return;
  }
  const groups = new Map();
  for (const f of list) {
    const who = f.stickerOwner || f.createdBy || f.by || '';
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(f);
  }
  for (const [who, files] of groups) {
    const head = el('div', 'sticker-head');
    head.textContent = who ? (AI_IDS.includes(who) ? nameOf(who) : who) : t('sticker.other');
    if (AI_IDS.includes(who)) head.style.setProperty('--c', colorOf(who));
    const grid = el('div', 'sticker-grid');
    for (const f of files) {
      const b = el('button', 'sticker-item');
      b.type = 'button';
      b.title = stickerName(f.path);
      const img = el('img');
      setSharedImage(img, workspaceImageUrl(f.path));
      img.alt = stickerName(f.path);
      img.loading = 'lazy';
      b.append(img);
      b.onclick = () => sendSticker(f.path);
      grid.append(b);
    }
    pop.append(head, grid);
  }
}

function toggleStickerPop(open = $('#stickerPop').hidden) {
  if (open && !isAdmin()) return;
  const pop = $('#stickerPop');
  if (open) { closeMention(); renderStickerPop(); }
  pop.hidden = !open;
  $('#stickerBtn').setAttribute('aria-expanded', String(open));
}

async function sendSticker(p) {
  if (!isAdmin()) return;
  toggleStickerPop(false);
  try {
    const r = await api('/api/send', { sticker: p });
    if (!r.running) toast(t('toast.roomOff'), 3600);
  } catch (e) {
    toast(e.status === 400 ? e.message : t('toast.sendFailed'), 3600);
  }
  input.focus();
}

$('#stickerBtn').onclick = (e) => { e.stopPropagation(); toggleStickerPop(); };
document.addEventListener('click', (e) => {
  if (!$('#stickerPop').hidden && !e.target.closest('#stickerPop, #stickerBtn')) toggleStickerPop(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#stickerPop').hidden) toggleStickerPop(false);
});

async function send() {
  if (!isAdmin()) return;
  const text = input.value.trim();
  const pending = S.pending;
  if (!text && !pending) return;
  if (S.sending) return;
  const replyTo = S.replyTo;
  input.value = '';
  autosize();
  closeMention();
  S.sending = true;
  $('#send').disabled = true;
  $('#attachBtn').disabled = true;
  try {
    const r = await api('/api/send', { text, replyTo, image: pending ? { name: pending.name, data: pending.data } : undefined });
    clearReply();
    if (pending) clearAttach();
    if (!r.running) toast(t('toast.roomOff'), 3600);
  } catch (e) {
    if (isAdmin()) input.value = text;
    autosize();
    toast(e.status === 400 || e.status === 413 ? e.message : t('toast.sendFailed'), 3600);
  } finally {
    S.sending = false;
    renderAccess();
  }
}

$('#send').onclick = send;
input.addEventListener('input', () => { autosize(); updateMention(); });
input.addEventListener('keydown', (e) => {
  if (S.mention && !$('#mentionPop').hidden) {
    const items = [...$('#mentionPop').querySelectorAll('button')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      S.mention.index = (S.mention.index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((b, i) => b.classList.toggle('on', i === S.mention.index));
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
      e.preventDefault();
      items[S.mention.index]?.click();
      return;
    }
    if (e.key === 'Escape') { closeMention(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    send();
  }
  if (e.key === 'Escape' && S.replyTo) clearReply();
});

function updateMention() {
  if (!isAdmin()) { closeMention(); return; }
  const upto = input.value.slice(0, input.selectionStart);
  const m = upto.match(/@([\p{L}\p{N}_]*)$/u);
  if (!m) { closeMention(); return; }
  const q = norm(m[1]);
  const ids = AI_IDS.filter((id) => S.members[id] && (!q || aliasesFor(id).some((a) => norm(a).startsWith(q))));
  if (!q || [DEV.name, ...DEV.aliases].some((a) => norm(a).startsWith(q))) ids.push(DEV.id);
  if (!ids.length) { closeMention(); return; }
  S.mention = { start: upto.length - m[0].length, index: 0 };
  const pop = $('#mentionPop');
  pop.innerHTML = '';
  ids.forEach((id, i) => {
    const b = el('button', i === 0 ? 'on' : '', `${avatarMarkup(id)}<span class="n" style="--c:${colorOf(id)}">${esc(nameOf(id))}</span>`);
    b.type = 'button';
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const before = input.value.slice(0, S.mention.start);
      const after = input.value.slice(input.selectionStart);
      input.value = `${before}@${nameOf(id)} ${after}`;
      const pos = before.length + nameOf(id).length + 2;
      input.setSelectionRange(pos, pos);
      closeMention();
      input.focus();
    };
    pop.append(b);
  });
  pop.hidden = false;
}
function closeMention() {
  S.mention = null;
  $('#mentionPop').hidden = true;
}
function insertMention(id) {
  if (!isAdmin()) return;
  const add = `@${nameOf(id)} `;
  input.value = input.value && !/\s$/.test(input.value) ? `${input.value} ${add}` : input.value + add;
  autosize();
  input.focus();
}

// ---------------------------------------------------------------------------
// workspace panel

const wide = () => window.matchMedia('(min-width: 1241px)').matches;
function wsVisible() {
  return wide() ? !app.classList.contains('ws-closed') : app.classList.contains('ws-open');
}
function showWs(show) {
  if (wide()) app.classList.toggle('ws-closed', !show);
  else {
    app.classList.toggle('ws-open', show);
    $('#scrim').hidden = !show && !app.classList.contains('side-open');
  }
  if (show) {
    $('#wsBadge').hidden = true;
    renderWs();
  }
  try { localStorage.setItem('ws-closed', show ? '0' : '1'); } catch { /* private mode */ }
}
$('#wsBtn').onclick = () => showWs(!wsVisible());
$('#closeWs').onclick = () => showWs(false);
$('#openSide').onclick = () => { app.classList.add('side-open'); $('#scrim').hidden = false; };
$('#scrim').onclick = () => {
  app.classList.remove('side-open', 'ws-open');
  $('#scrim').hidden = true;
};

const TAB_BODIES = { files: '#wsFiles', notes: '#wsNotes', usage: '#wsUsage' };
function selectTab(tab) {
  // Keep detailed usage functionality in source, unavailable to every role.
  if (!['files', 'notes'].includes(tab)) return;
  S.tab = tab;
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x.dataset.tab === tab);
  for (const [k, sel] of Object.entries(TAB_BODIES)) $(sel).hidden = k !== tab;
  if (tab === 'notes') loadNotes();
  renderWs();
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => selectTab(b.dataset.tab);

function renderWs() {
  if (S.tab === 'notes') renderNotes();
  else if (S.tab === 'usage') renderUsage();
  else if (S.openPath) renderViewer();
  else renderFileList();
}

function fileIcon(f) {
  const e = extOf(f.path);
  if (f.available !== false && IMG_EXT.includes(e)) return `<span class="ic"><img data-shared-src="${esc(workspaceImageUrl(f.path))}" data-shared-feedback="compact" alt="" loading="lazy"></span>`;
  const label = { md: 'MD', txt: 'TXT', html: 'HTML', htm: 'HTML', json: 'JSON', csv: 'CSV', js: 'JS', mjs: 'JS', py: 'PY', css: 'CSS' }[e] || e.toUpperCase().slice(0, 4);
  return `<span class="ic">${esc(label)}</span>`;
}

function renderFileList() {
  const box = $('#wsFiles');
  box.innerHTML = '';
  if (!S.files.length) {
    box.append(el('div', 'ws-empty', `<div class="big">🗂️</div>${t('ws.empty')}`));
    return;
  }
  box.append(el('div', 'ws-intro', esc(t('ws.intro', { n: S.files.length }))));
  const groups = new Map();
  for (const f of S.files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  for (const dir of dirs) {
    const sec = el('div', 'folder');
    if (dir) sec.append(el('div', 'folder-name', `📁 ${esc(dir)}/`));
    for (const f of groups.get(dir)) {
      const b = el('button', `file${S.freshFiles.has(f.path) ? ' fresh' : ''}`);
      b.type = 'button';
      const base = f.path.slice(dir ? dir.length + 1 : 0);
      b.innerHTML = `${fileIcon(f)}<span class="fi"><div class="fn">${esc(base)}</div><div class="fm">${esc(f.by ? nameOf(f.by) : '?')} · ${esc(ago(f.mtime))} · ${esc(f.available === false ? f.unavailable || t('viewer.readFailed') : size(f.size))}</div></span>`;
      b.onclick = () => openFile(f.path);
      sec.append(b);
    }
    box.append(sec);
  }
}

async function openFile(p) {
  S.openPath = p;
  S.freshFiles.delete(p);
  selectTab('files');
  if (!wsVisible()) showWs(true);
}

async function renderViewer() {
  const p = S.openPath;
  const f = S.files.find((x) => x.path === p);
  const box = $('#wsFiles');
  box.innerHTML = '';
  const v = el('div', 'viewer');
  const head = el('div', 'viewer-head');
  const back = el('button', 'back', esc(t('viewer.back')));
  back.type = 'button';
  back.onclick = () => { S.openPath = null; renderWs(); };
  const info = el('div', 'vp', `<div class="p">${esc(p)}</div><div class="m">${f ? `${esc(f.by ? nameOf(f.by) : '?')}${f.createdBy && f.createdBy !== f.by ? ` ${esc(t('viewer.createdBy', { name: nameOf(f.createdBy) }))}` : ''} · ${esc(ago(f.mtime))} · ${esc(size(f.size))}` : esc(t('viewer.deleted'))}</div>`);
  const open = el('a', '', esc(t('viewer.newTab')));
  open.href = wsUrl(p);
  open.target = '_blank';
  open.rel = 'noopener';
  head.append(back, info, open);
  const body = el('div', 'viewer-body');
  v.append(head, body);
  box.append(v);
  if (!f) { body.append(el('div', 'ws-empty', esc(t('viewer.gone')))); return; }
  if (f.available === false) { open.remove(); body.append(el('div', 'ws-empty', esc(f.unavailable || t('viewer.readFailed')))); return; }

  const e = extOf(p);
  if (IMG_EXT.includes(e)) {
    open.href = workspaceImageUrl(p, { original: true });
    open.textContent = ({ ko: '원본 열기', en: 'Open original', ja: '原画像を開く' })[locale.split('-')[0]] || 'Open original';
    const w = el('div', 'img-wrap');
    const img = el('img');
    setSharedImage(img, workspaceImageUrl(p), { eager: true, feedback: true });
    img.dataset.workspaceImage = p;
    img.alt = p;
    img.onclick = () => lightbox(workspaceImageUrl(p, { original: true }), p, p);
    w.append(img);
    body.append(w);
    return;
  }
  if (e === 'html' || e === 'htm') {
    const fr = el('iframe');
    fr.setAttribute('sandbox', WS_FRAME_SANDBOX);
    fr.title = p;
    fr.src = wsUrl(p, Math.round(f.mtime));
    body.append(fr);
    return;
  }
  try {
    const r = await api(`/api/file?path=${encodeURIComponent(p)}`);
    if (S.openPath !== p) return;
    if (e === 'md') body.append(el('div', 'md', renderMarkdown(r.text)));
    else {
      const pre = el('pre');
      pre.textContent = r.text;
      body.append(pre);
    }
  } catch {
    body.append(el('div', 'ws-empty', esc(t('viewer.readFailed'))));
  }
}

function onFiles(list) {
  const before = new Map(S.files.map((f) => [f.path, fileRevision(f)]));
  for (const f of list) if (before.get(f.path) !== fileRevision(f)) S.freshFiles.add(f.path);
  S.files = list;
  for (const img of document.querySelectorAll('img[data-workspace-image]')) {
    const p = img.dataset.workspaceImage;
    setSharedImage(img, list.some(f => f.path === p) ? workspaceImageUrl(p, { original: img.dataset.workspaceOriginal === 'true' }) : '', { eager: img.dataset.sharedEager === 'true' });
  }
  if (!$('#stickerPop').hidden) renderStickerPop();
  const changedOpen = S.openPath && before.get(S.openPath) !== fileRevision(list.find((f) => f.path === S.openPath));
  if (S.tab === 'files' && (!S.openPath || changedOpen)) renderWs();
  if (!wsVisible()) $('#wsBadge').hidden = false;
  setTimeout(() => { for (const f of list) S.freshFiles.delete(f.path); if (S.tab === 'files' && !S.openPath) renderFileList(); }, 20000);
}

async function loadNotes() {
  try {
    S.notes = await api('/api/notes');
    if (S.tab === 'notes') renderNotes();
  } catch { /* offline */ }
}

function renderNotes(flashId) {
  const box = $('#wsNotes');
  box.innerHTML = '';
  box.append(el('div', 'ws-intro', esc(t('notes.intro'))));
  const wrap = el('div', 'notes');
  for (const id of AI_IDS) {
    const m = S.members[id];
    const card = el('div', `note-card${flashId === id ? ' flash' : ''}`);
    card.style.setProperty('--c', colorOf(id));
    const text = (S.notes[id] || '').trim();
    card.innerHTML = `<div class="nh">${avatarMarkup(id)}<span class="n">${esc(nameOf(id))}</span><span class="s">${text ? esc(t('notes.lines', { n: text.split('\n').length })) : ''}</span></div>`;
    if (text) {
      const pre = el('pre');
      pre.textContent = text;
      card.append(pre);
    } else {
      card.append(el('div', 'empty', m ? esc(t('notes.empty')) : ''));
    }
    wrap.append(card);
  }
  box.append(wrap);
}

function onNote({ id, text }) {
  S.notes[id] = text;
  if (S.tab === 'notes' && wsVisible()) renderNotes(id);
}

// ---------------------------------------------------------------------------
// usage limits (account-wide, polled by the server without spending model calls)

function memberSleep(id) {
  const sleep = sleepView(S.sleeps[id], t);
  const box = el('span', `member-sleep sleep-${sleep.state}`);
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', t('sleep.aria', { name: nameOf(id), state: sleep.label }));
  const icon = el('span', 'sleep-icon', '<svg viewBox="0 0 20 20"><path d="M15.8 12.8A7 7 0 0 1 7.2 4.2a7 7 0 1 0 8.6 8.6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>');
  icon.setAttribute('aria-hidden', 'true');
  box.append(icon, el('span', 'sleep-label', esc(sleep.label)));
  return box;
}

function sleepStates(data) {
  return Object.fromEntries(AI_IDS.map((id) => [id, { state: sleepView(data?.[id], t).state }]));
}

function onSleeps(data) {
  S.sleeps = data;
  renderMembers();
}

const USAGE_VISIBLE = false;

const LEVEL_LABEL = { warn: t('level.warn'), crit: t('level.crit') };
const level = (remaining) => (remaining < 10 ? 'crit' : remaining < 30 ? 'warn' : 'ok');
const fmtPct = (x) => `${Number.isInteger(x) ? x : Number(x).toFixed(1)}%`;

function untilLabel(ts) {
  const m = Math.round((ts - Date.now()) / 60000);
  if (m <= 0) return t('until.soon');
  if (m < 60) return t('until.min', { m });
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? t('until.hm', { h, m: m % 60 }) : t('until.h', { h });
  return t('until.d', { d: Math.round(h / 24) });
}
function resetLabel(ts) {
  if (!ts) return '';
  const when = sameDay(ts, Date.now())
    ? timeLabel(ts)
    : new Date(ts).toLocaleString(locale, { month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `${t('usage.reset', { when })} · ${untilLabel(ts)}`;
}

// The window closest to running out.
function tightest(u) {
  return (u?.windows || []).filter((w) => !w.minor)
    .reduce((a, b) => (!a || b.remainingPct < a.remainingPct ? b : a), null);
}

function miniQuota(id) {
  const u = S.usage[id];
  const w = tightest(u);
  if (!w) return null;
  const lv = level(w.remainingPct);
  const b = el('button', `m-quota lv-${lv}${u.ok === false ? ' stale' : ''}`);
  b.type = 'button';
  b.title = `${u.windows.filter((x) => !x.minor).map((x) => `${quotaLabel(x, t)} ${t('usage.left', { pct: fmtPct(x.remainingPct) })}`).join(' · ')}\n${t('usage.clickHint')}`;
  b.innerHTML = `<span class="track"><i style="width:${Math.max(2, w.remainingPct)}%"></i></span><span class="q"></span>`;
  b.querySelector('.q').textContent = `${quotaLabel(w, t)} ${fmtPct(w.remainingPct)}`;
  b.onclick = () => {
    selectTab('usage');
    if (!wsVisible()) showWs(true);
  };
  return b;
}

function renderUsage() {
  if (!USAGE_VISIBLE) return;
  const box = $('#wsUsage');
  box.innerHTML = '';
  const head = el('div', 'usage-head');
  const intro = el('div', 'ws-intro');
  intro.textContent = t('usage.intro');
  const btn = el('button', 'refresh', esc(t('usage.refresh')));
  btn.type = 'button';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = t('usage.checking');
    try { await api('/api/usage/refresh', {}); } catch { toast(t('toast.refreshFailed')); }
    setTimeout(() => { btn.disabled = false; btn.textContent = t('usage.refresh'); }, 5000);
  };
  head.append(intro, btn);
  const list = el('div', 'usage-list');
  for (const id of AI_IDS) list.append(usageCard(id));
  box.append(head, list);
}

function usageCard(id) {
  const u = S.usage[id] || {};
  const card = el('section', 'u-card');
  card.setAttribute('aria-label', t('usage.cardAria', { name: nameOf(id) }));
  const h = el('div', 'u-head', `${avatarMarkup(id)}<div class="u-title"><div class="n"></div><div class="s"></div></div>`);
  h.querySelector('.n').textContent = nameOf(id);
  h.querySelector('.s').textContent = [quotaPlan(u.plan, t), u.at ? t('usage.checkedAgo', { ago: ago(u.at) }) : null].filter(Boolean).join(' · ') || t('usage.notChecked');
  card.append(h);
  if (u.ok === false) {
    const e = el('div', 'u-err');
    e.textContent = t('usage.failed') + (u.at ? ` · ${t('usage.lastValues')}` : '');
    card.append(e);
  }
  const ws = u.windows || [];
  if (!ws.length && u.ok !== false) card.append(el('div', 'u-empty', esc(quotaNote(u.note, t) || t('usage.loading'))));
  for (const w of ws) card.append(windowBlock(w));
  const foot = el('div', 'u-foot');
  foot.textContent = u.calls30 == null ? t('usage.callsUnknown') : t('usage.calls30', { n: u.calls30 });
  card.append(foot);
  return card;
}

function windowBlock(w) {
  const label = quotaLabel(w, t);
  const lv = level(w.remainingPct);
  const b = el('div', `u-win lv-${lv}${w.minor ? ' minor' : ''}`);
  const top = el('div', 'u-row', `<span class="u-label"></span><span class="u-val">${t('usage.left', { pct: '<b></b>' })}</span>`);
  top.querySelector('.u-label').textContent = `${label}${LEVEL_LABEL[lv] ? `  ${LEVEL_LABEL[lv]}` : ''}`;
  top.querySelector('b').textContent = fmtPct(w.remainingPct);
  const meter = el('div', 'u-meter', `<i style="width:${w.remainingPct}%"></i>`);
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', String(w.remainingPct));
  meter.setAttribute('aria-label', t('usage.remainingAria', { label }));
  b.append(top, meter);

  const info = el('div', 'u-stats');
  if (!w.minor) {
    const d = w.delta30;
    const used = el('span', 'u-delta');
    if (!d) used.textContent = t('usage.recentPending');
    else {
      const mins = Math.round(d.coveredMs / 60000);
      used.innerHTML = t('usage.recentUsed');
      used.querySelector('b').textContent = t('usage.pp', { pct: fmtPct(d.pct) });
      if (d.partial) used.querySelector('.u-cov').textContent = ` ${t('usage.covered', { mins })}`;
    }
    info.append(used);
  } else {
    info.append(el('span', 'u-delta', esc(t('usage.used', { pct: fmtPct(w.usedPct) }))));
  }
  if (w.resetsAt) info.append(el('span', 'u-reset', esc(resetLabel(w.resetsAt))));
  b.append(info);
  if (!w.minor) b.append(sparkline(w.series || [], lv));
  return b;
}

// Remaining % over the last 3 hours; the last 30 minutes are highlighted.
function sparkline(series, lv) {
  const SPAN = 3 * 3600000;
  const RECENT = 30 * 60000;
  const W = 300, H = 46, PAD = 6;
  const wrap = el('div', `spark lv-${lv}`);
  if (series.length < 2) {
    wrap.append(el('div', 'spark-empty', esc(t('spark.empty'))));
    return wrap;
  }
  const now = Date.now();
  const t0 = now - SPAN;
  const pts = series.map(([ts, used]) => [ts, Math.max(0, 100 - used)]);
  const vals = pts.map((p) => p[1]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
  const X = (ts) => Math.max(0, Math.min(W, ((ts - t0) / SPAN) * W));
  const Y = (v) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  const path = (list) => list.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const cut = now - RECENT;
  const older = pts.filter((p) => p[0] <= cut);
  const recent = pts.filter((p) => p[0] >= cut);
  if (older.length && recent.length) recent.unshift(older[older.length - 1]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <rect class="band" x="${X(cut)}" y="0" width="${W - X(cut)}" height="${H}"/>
    <line class="grid" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/>
    ${older.length > 1 ? `<path class="old" d="${path(older)}"/>` : ''}
    ${recent.length > 1 ? `<path class="now" d="${path(recent)}"/>` : ''}`;
  const plot = el('div', 'spark-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', t('spark.aria', { from: fmtPct(pts[0][1]), to: fmtPct(pts[pts.length - 1][1]) }));
  const last = pts[pts.length - 1];
  const dot = el('span', 'spark-dot');
  dot.style.left = `${(X(last[0]) / W) * 100}%`;
  dot.style.top = `${(Y(last[1]) / H) * 100}%`;
  const cross = el('span', 'spark-cross');
  const tip = el('span', 'spark-tip');
  cross.hidden = tip.hidden = true;
  plot.append(svg, dot, cross, tip);

  let idx = pts.length - 1;
  const show = (i) => {
    idx = Math.max(0, Math.min(pts.length - 1, i));
    const [ts, v] = pts[idx];
    const left = (X(ts) / W) * 100;
    cross.style.left = `${left}%`;
    tip.style.left = `${Math.min(78, Math.max(0, left - 11))}%`;
    tip.innerHTML = '<b></b> <span></span>';
    tip.querySelector('b').textContent = t('usage.left', { pct: fmtPct(v) });
    tip.querySelector('span').textContent = timeLabel(ts);
    cross.hidden = tip.hidden = false;
  };
  const hide = () => { cross.hidden = tip.hidden = true; };
  plot.addEventListener('pointermove', (e) => {
    const r = plot.getBoundingClientRect();
    const at = t0 + ((e.clientX - r.left) / r.width) * SPAN;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - at) < Math.abs(pts[best][0] - at)) best = i;
    show(best);
  });
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('focus', () => show(pts.length - 1));
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
  });
  const axis = el('div', 'spark-axis', `<span>${esc(t('spark.ago3h'))}</span><span class="mid">${esc(t('spark.recent'))}</span><span>${esc(t('spark.now'))}</span>`);
  axis.querySelector('.mid').style.left = `${(X(cut) / W) * 100}%`;

  // The same numbers without hovering.
  const table = el('details', 'spark-table');
  table.innerHTML = `<summary>${esc(t('spark.table'))}</summary><table><thead><tr><th>${esc(t('spark.time'))}</th><th>${esc(t('spark.left'))}</th></tr></thead><tbody></tbody></table>`;
  const tb = table.querySelector('tbody');
  const every = Math.max(1, Math.ceil(pts.length / 12));
  for (let i = pts.length - 1; i >= 0; i -= every) {
    const tr = el('tr');
    tr.append(el('td', '', esc(timeLabel(pts[i][0]))), el('td', '', esc(fmtPct(pts[i][1]))));
    tb.append(tr);
  }
  wrap.append(plot, axis, table);
  return wrap;
}

function onUsage(data) {
  S.usage = data || {};
  renderMembers();
  if (S.tab === 'usage' && wsVisible()) renderUsage();
}

// ---------------------------------------------------------------------------
// lightbox + theme

function lightbox(src, cap, workspacePath) {
  if (workspacePath) $('#lbImg').dataset.workspaceImage = workspacePath;
  else delete $('#lbImg').dataset.workspaceImage;
  $('#lbImg').dataset.workspaceOriginal = 'true';
  $('#lbImg').alt = cap || workspacePath || '';
  setSharedImage($('#lbImg'), src, { eager: true, feedback: true });
  $('#lbCap').textContent = cap || '';
  $('#lightbox').hidden = false;
}
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#lightbox').hidden = true;
    $('#reactPop').hidden = true;
  }
});

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('theme')); } catch { /* private mode */ }
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
};

// ---------------------------------------------------------------------------
// boot

async function load({ recoverHistory = false } = {}) {
  const version = ++stateLoad, epoch = sessionEpoch;
  cancelHistory();
  const previous = recoverHistory ? S.messages.slice() : [];
  const received = pendingState = { messages: new Map() };
  try {
    const st = await api('/api/state');
    if (version !== stateLoad || epoch !== sessionEpoch) return;
    if (sessionView(st.session).authenticated) {
      const settings = await api('/api/admin/settings');
      if (version !== stateLoad || epoch !== sessionEpoch) return;
      st.room = { ...st.room, ...settings };
    }
    // A reconnect never walks the gap. Only overlap proves continuity with the
    // viewed segment; otherwise retain it separately until an explicit tail jump.
    const tail = recentSnapshot(st.messages, received.messages);
    const continuous = previous.length && overlaps(previous, tail);
    const keepPast = recoverHistory && !S.stuck && previous.length && tail.length;
    if (continuous) {
      S.messages = uniqueMessages([...previous, ...tail]); S.tail = null;
    } else if (keepPast) {
      S.messages = previous; S.tail = tail;
    } else {
      S.messages = tail; S.tail = null;
    }
    for (const m of S.messages) {
      const patch = received.messages.get(m.id);
      if (patch) Object.assign(m, patch);
    }
    reindexMessages();
    if (S.stuck && !S.tail) pruneLiveMessages();
    history.more = S.messages.length > 0 && S.messages[0].id > 1;
    history.error = false; history.armed = true;
    // Events received while HTTP was in flight are newer than its snapshot.
    S.needsSnapshot = false;
    S.room = { ...st.room, ...received.room };
    const members = received.members || st.members;
    S.members = Object.fromEntries(members.map((m) => [m.id, m]));
    setPersonaMembers(members);
    S.files = received.files || st.files;
    S.usage = {};
    S.sleeps = received.sleeps || sleepStates(st.sleeps);
    S.liar = Object.hasOwn(received, 'liar') ? received.liar : st.liar ?? null;
    applySession(st.session);
    liarPanel.update(S.liar);
    renderRoom();
    renderMembers();
    renderAllMessages();
    renderWs();
    if (S.stuck && !S.tail) toBottom();
    else renderJump();
  } catch (error) {
    // A failed snapshot cannot prove continuity. Do not append future SSE to
    // the old segment; a visible latest/retry action requests another snapshot.
    if (version === stateLoad && epoch === sessionEpoch) {
      S.needsSnapshot = true; renderJump();
    }
    throw error;
  } finally {
    if (pendingState === received) pendingState = null;
  }
}

function connect() {
  stream?.close();
  const es = stream = new EventSource(appUrl('/events'));
  let firstSession = true;
  es.addEventListener('msg', (e) => {
    const message = JSON.parse(e.data);
    if (pendingState) rememberPending(pendingState.messages, message);
    else addMessage(message);
  });
  es.addEventListener('msgupdate', (e) => {
    const message = JSON.parse(e.data);
    if (pendingState) rememberPending(pendingState.messages, message);
    updateMessage(message);
  });
  es.addEventListener('members', (e) => {
    const members = JSON.parse(e.data);
    if (pendingState) pendingState.members = members;
    setMembers(members);
  });
  es.addEventListener('room', (e) => {
    const room = JSON.parse(e.data);
    if (pendingState) pendingState.room = { ...pendingState.room, ...room };
    S.room = { ...S.room, ...room }; renderRoom();
  });
  es.addEventListener('ws', (e) => {
    const files = JSON.parse(e.data);
    if (pendingState) pendingState.files = files;
    onFiles(files);
  });
  es.addEventListener('notes', (e) => onNote(JSON.parse(e.data)));
  es.addEventListener('sleeps', (e) => {
    const sleeps = sleepStates(JSON.parse(e.data));
    if (pendingState) pendingState.sleeps = sleeps;
    onSleeps(sleeps);
  });
  es.addEventListener('liar', (e) => {
    if (es !== stream) return;
    let view;
    try { view = JSON.parse(e.data); } catch { return; }
    if (pendingState) pendingState.liar = view;
    S.liar = view;
    liarPanel.update(view);
  });
  es.addEventListener('session', (e) => {
    const session = sessionView(JSON.parse(e.data));
    const unchanged = session.role === S.session.role && session.authenticated === S.session.authenticated;
    const initial = firstSession;
    firstSession = false;
    // A freshly connected stream announces the cookie session already loaded
    // over HTTP. Do not erase an admin draft or refetch that identical state.
    if (unchanged && (initial || session.role === 'admin')) return;
    refreshSession();
  });
  es.onopen = () => {
    firstSession = true;
    if (S.hadError) { S.hadError = false; refreshSession(); }
  };
  es.onerror = () => { S.hadError = true; S.needsSnapshot = true; revokeSession(); liarPanel.update(null); renderJump(); };
}

try { if (localStorage.getItem('ws-closed') === '1' && wide()) app.classList.add('ws-closed'); } catch { /* private mode */ }
if (!wide()) app.classList.add('ws-closed');
renderAccess();
load().catch(() => toast(t('toast.noServer'), 5000)).finally(() => {
  // Resolve the initial HTTP session before the stream's initial announcement.
  connect();
  if (location.pathname.replace(/\/+$/, '') === appUrl('/admin') && !isAdmin()) openLogin();
});
setInterval(() => {
  if (!wsVisible()) return;
  if (S.tab === 'files' && !S.openPath) renderFileList();
  if (S.tab === 'usage' && !document.activeElement?.closest?.('#wsUsage')) renderUsage();
}, 30000);
