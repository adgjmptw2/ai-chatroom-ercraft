// SERVER ONLY. Never ship this module or its reverse maps to a browser.
import { createHash } from 'node:crypto';

const IDS = Object.freeze({ claude: 'eleven', gpt: 'adina', deepseek: 'lucia', gemini: 'bianca', grok: 'former-member', dev: 'dev', user: 'user', system: 'system' });
const REVERSE = Object.fromEntries(Object.entries(IDS).map(([a, b]) => [b, a]));
const own = (object, key) => Object.hasOwn(object, key);
export const NON_DISCLOSURE = '[비공개]';
export const publicId = id => own(IDS, id) ? IDS[id] : id;
// Call only after admin authentication, never to accept private IDs in browser controls.
export const internalMemberId = id => own(REVERSE, id) ? REVERSE[id] : null;
export const neutralToken = (value, prefix = 'item') => `${prefix}-${createHash('sha256').update(String(value)).digest('hex')}`;

const KNOWN = [
  'claude', 'chatgpt', 'chat gpt', 'gpt', 'deepseek', 'deep seek', 'gemini', 'grok',
  'anthropic', 'openai', 'open ai', 'google', 'xai', 'x.ai', 'hive', 'thehive',
  'opencodex', 'codex', 'antigravity', 'cursor', 'sonnet', 'opus', 'haiku', 'astra',
  '클로드', '클라우드 AI', '지피티', '챗지피티', '쳇지피티', '챗GPT', '딥시크', '딥시크AI',
  '제미나이', '제미니', '그록', '앤트로픽', '앤스로픽', '오픈에이아이', '오픈AI', '구글', '하이브', '코덱스', '커서', '안티그래비티', '소네트', '소넷', '오퍼스', '오푸스', '하이쿠', '아스트라',
  'クロード', 'クロードAI', 'チャットGPT', 'チャットジーピーティー', 'チャッピー', 'ジーピーティー', 'ディープシーク', 'ジェミニ', 'ジェミナイ', 'グロック', 'グロク',
  'アンソロピック', 'オープンAI', 'オープンエーアイ', 'グーグル', 'ハイブ', 'コーデックス', 'カーソル', 'ソネット', 'オーパス', 'ハイク',
];
const PRIVATE_FIELD = /^(?:legacyAliases|imageVision|imageGen|maker|models?|defaultModel|boostModel|imageModel|providers?|providerId|providerConfigPath|connection|endpoint|baseUrl|apiUrl|apiKey|authorization|credentials?|password|tokens?|routing|route|lastError|boostWhy)$/i;
const CONFIG_ID = /(?:model|provider|maker|endpoint|baseurl|apiurl|connection|account|apikey|password|secret|token|configpath)/i;
const ID_FIELD = /^(?:id|from|by|createdBy|owner|member|memberId|author|who|requestedBy)$/;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createPublicIdentity(config = {}, extraIdentifiers = []) {
  const words = new Set([...KNOWN, ...extraIdentifiers].filter(x => typeof x === 'string' && x.length > 1));
  const collect = (value, key = '', privateBranch = false) => {
    const sensitive = privateBranch || CONFIG_ID.test(key);
    if (typeof value === 'string' && sensitive && value.length > 1) {
      words.add(value);
      // Hide the connection host as well as a full configured URL/path.
      try { const u = new URL(value); if (u.hostname) words.add(u.hostname); } catch {}
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) collect(v, k, sensitive);
    }
  };
  collect(config);
  const alternatives = [...words].sort((a, b) => b.length - a.length).map(word => {
    // ASCII identifiers have word boundaries; Hangul/Kana may have attached particles.
    const term = escape(word);
    return /^[\x00-\x7f]+$/.test(word) ? `(?<![a-z0-9])${term}(?![a-z])` : term;
  });
  const family = '(?<![a-z0-9])(?:claude|chatgpt|gpt|deepseek|gemini|grok|codex|sonnet|opus|haiku)(?:[-_./][a-z0-9][a-z0-9_.-]*)*';
  const pattern = new RegExp([family, ...alternatives].join('|'), 'giu');
  const text = value => String(value ?? '').replace(pattern, NON_DISCLOSURE);
  const contains = value => text(value) !== String(value ?? '');
  // Paths/keys may embed a provider without word separators (myClaudeNotes).
  const pathPattern = new RegExp([...words].sort((a,b) => b.length-a.length).map(escape).join('|'), 'iu');
  const sensitivePath = value => pathPattern.test(String(value).normalize('NFKC'));
  const key = value => own(IDS, value) ? IDS[value] : sensitivePath(value) ? neutralToken(value, 'entry') : value;
  const assetPath = value => {
    if (typeof value !== 'string') return value;
    const match = /^\/assets\/characters\/([^/]+)\/([a-zA-Z0-9_-]+\.png)$/.exec(value);
    if (!match || !own(IDS, match[1]) && !own(REVERSE, match[1])) return null;
    return `/assets/characters/${publicId(match[1])}/${match[2]}`;
  };
  const project = (value, field = '') => {
    if (typeof value === 'string') {
      if (ID_FIELD.test(field) || field === 'reactions') return own(IDS, value) ? IDS[value] : text(value);
      if (value.startsWith('/assets/characters/')) return assetPath(value);
      return text(value);
    }
    if (Array.isArray(value)) return value.map(v => project(v, field));
    if (!value || typeof value !== 'object') return value;
    const entries = [], used = new Set();
    // Reserve unchanged names first so a malicious public/private pair cannot overwrite.
    const reserved = new Set(Object.keys(value).filter(k => key(k) === k));
    for (const [k, v] of Object.entries(value)) {
      if (PRIVATE_FIELD.test(k)) continue;
      let name = key(k);
      if (used.has(name) || name !== k && reserved.has(name)) name = neutralToken(k, 'entry');
      let n = 0;
      while (used.has(name) || name !== k && reserved.has(name)) name = neutralToken(`${k}:${++n}`, 'entry');
      used.add(name);
      entries.push([name, project(v, field === 'reactions' ? 'reactions' : k)]);
    }
    return Object.fromEntries(entries);
  };
  // Reserved namespace keeps neutral custom-block names distinct from stored names.
  const blockName = name => sensitivePath(name) || String(name).startsWith('private-block-') ? neutralToken(name, 'private-block') : name;
  const block = value => typeof value === 'string' ? value.split('/').map(blockName).join('/') : value;
  const world = value => {
    const out = project(value);
    if (value.custom) out.custom = Object.fromEntries(Object.entries(value.custom).map(([k,v]) => [blockName(k), project(v)]));
    for (const field of ['blocks', 'changes']) if (Array.isArray(value[field])) out[field] = value[field].map(cell => Array.isArray(cell) ? cell.map((v,i) => i === 3 ? block(v) : project(v)) : project(cell));
    return out;
  };
  return Object.freeze({ text, contains, sensitivePath, key, project, assetPath, blockName, world });
}

export const defaultPublicIdentity = createPublicIdentity();

// Whitelisted public routes resolve to retained internal directories without redirects.
export function resolveCharacterAsset(requestPath) {
  const match = /^\/assets\/characters\/([a-z-]+)\/(full|avatar)\.png$/.exec(requestPath);
  const id = match && internalMemberId(match[1]);
  return id && !['user', 'system', 'grok'].includes(id) ? `assets/characters/${id}/${match[2]}.png` : null;
}
