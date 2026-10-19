// Stable provider IDs and capabilities. Character presentation lives in personas.mjs.

import { pick } from './i18n.mjs';
import { personaFor, DEV_PERSONA } from './personas.mjs';

export const AI_IDS = ['claude', 'gpt', 'deepseek', 'gemini'];

// aliases: every spelling that calls the member, in any room language (lower case).
// look: the default avatar, per language (config.json members.<id>.look overrides it).
function character(id, provider) {
  const persona = personaFor(id);
  return { ...provider, name: persona.name, aliases: persona.aliases, legacyAliases: persona.legacyAliases, look: persona.look, persona };
}

export const MEMBERS = {
  // Pink / green / ochre: >=4.5:1 on white and >=3:1 on the existing dark surfaces.
  claude: character('claude', {
    maker: 'Anthropic',
    color: '#c34b83',
    imageGen: false,
  }),
  gpt: character('gpt', {
    maker: 'OpenAI',
    color: '#258552',
    imageGen: true,
  }),
  deepseek: character('deepseek', {
    maker: 'DeepSeek (Hive)', color: '#4f65de',
    imageGen: false,
  }),
  grok: {
    name: 'Grok',
    maker: 'xAI',
    color: '#b8912a',
    aliases: ['grok', '그록', 'グロック', 'グロク'],
    look: {
      ko: '긴 금발, 회색 눈, 검은 X 머리핀, 검은 오버사이즈 재킷과 초커',
      en: 'long blonde hair, grey eyes, a black X hairpin, an oversized black jacket and a choker',
      ja: '長い金髪、灰色の瞳、黒いXのヘアピン、黒いオーバーサイズジャケットとチョーカー',
    },
    imageGen: true,
  },
  gemini: character('gemini', {
    maker: 'Google',
    color: '#957100',
    accentColor: '#e8c21c',
    imageGen: true,
  }),
};

export function defaultLook(id) {
  return MEMBERS[id] ? pick(MEMBERS[id].look) : '';
}

// The real development session, presented as Nadja. It is not
// scheduled like the AIs: it joins through the dev bridge (lib/dev.mjs) only while the
// user has connected it, and its messages are authored by the server from the bridge token.
export const DEV = {
  id: 'dev',
  get name() { return pick(DEV_PERSONA.names); },
  color: '#0f766e',
  aliases: DEV_PERSONA.aliases,
  persona: DEV_PERSONA,
};

const SYSTEM_NAMES = { ko: '시스템', en: 'System', ja: 'システム' };

// Latin aliases must stand alone ("dev" is not "device"); Korean and Japanese have no
// word spaces to rely on, so those match anywhere.
function hasAlias(t, a) {
  if (!/^[a-z0-9 ]+$/.test(a)) return t.includes(a);
  return new RegExp(`(^|[^a-z0-9])${a}($|[^a-z0-9])`).test(t);
}

// Does `text` call the dev session (@Dev, 개발자, 開発者 ...)?
export function mentionsDev(text) {
  const t = (text || '').toLowerCase();
  return DEV.aliases.some((a) => hasAlias(t, a));
}

export function displayName(id, userName) {
  if (id === 'user') return userName;
  if (id === 'system') return pick(SYSTEM_NAMES);
  if (id === DEV.id) return DEV.name;
  return MEMBERS[id]?.name ?? id;
}

// Compute Korean particles from the current displayed Hangul, including renamed members.
function finalConsonant(word) {
  const c = String(word ?? '').trimEnd().normalize('NFC').at(-1)?.charCodeAt(0);
  return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0;
}
export function endsWithBatchim(word) { return finalConsonant(word) !== 0; }

// withJosa('claude', '방장', '이/가') -> '일레븐이'. `id` may also be a plain word.
export function withJosa(id, userName, pair) {
  const [withFinal, without] = pair.split('/');
  const word = MEMBERS[id] || id === 'user' || id === 'system' || id === DEV.id ? displayName(id, userName) : id;
  const fin = finalConsonant(id === 'grok' ? '그록' : word);
  return word + (fin && !(withFinal === '으로' && fin === 8) ? withFinal : without);
}

// Does `text` address member `id`? Matches @Name and bare names/aliases.
export function mentions(text, id) {
  const t = (text || '').toLowerCase();
  const m = MEMBERS[id];
  if (!m) return false;
  return m.aliases.some((a) => hasAlias(t, a));
}

// Stricter: only an explicit @Name counts as calling someone.
export function atMentions(text, id) {
  const t = (text || '').toLowerCase();
  return !!MEMBERS[id]?.aliases.some((a) => /^[a-z0-9 ]+$/.test(a)
    ? new RegExp(`@${a}($|[^a-z0-9])`).test(t)
    : t.includes('@' + a));
}

// A render-only compatibility hint, not a claim that a note was written before a rename.
export function legacyIdentityIds(text) {
  const t = String(text || '').toLowerCase();
  return AI_IDS.filter((id) => personaFor(id)?.legacyAliases.some((a) => hasAlias(t, a)));
}
