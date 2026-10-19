// Builds the per-turn prompt for one AI. Every call is self-contained: the model sees
// the room brief, its private notes, the workspace and the recent chat, then answers
// with a single JSON action.
//
// The wording lives in language packs (lib/prompts/<lang>.mjs); the room language decides
// which one is used, so the members chat in that language.

import { MEMBERS, AI_IDS, DEV, displayName, mentions, defaultLook, legacyIdentityIds } from './members.mjs';
import { personaFor, personaBrief, personaTurnCue, personaProvenance, rosterHint } from './personas.mjs';
import { developerPromptCue } from './dev.mjs';
import { PALETTE as WORLD_PALETTE } from './world.mjs';
import { pick, DEV_REQUEST_FILE } from './i18n.mjs';
import ko from './prompts/ko.mjs';
import en from './prompts/en.mjs';
import ja from './prompts/ja.mjs';
import { constructionAllowed } from './world-actions.mjs';
import { efficientConversation, selectConversationHistory, compactLivingBrief } from './conversation-efficiency.mjs';
import { ER_LORE_BASE, eternalReturnContext } from './eternal-return-lore.mjs';
import { conversationMemory } from './conversation-memory.mjs';
import { NATURAL_DIALOGUE_BRIEF } from './natural-dialogue.mjs';

const PACKS = { ko, en, ja };
const pack = () => pick(PACKS);
export const plannerBrief = (cfg = {}) => !constructionAllowed(cfg) ? '' : cfg.planner?.enabled === false ? pack().plannerDisabled : pack().plannerBrief;
// Hive's chat adapter has no search tool, even if the room enables search.
const canSearchFor = (id, cfg) => !!cfg.webSearch && id !== 'deepseek';

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
const secs = (ms) => Math.round(ms / 1000);
function kb(n) { return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`; }

// Internal routing/status label only. Never add this to a conversation prompt.
export function modelLabel(conf) {
  if (!conf?.model) return '';
  return conf.effort ? `${conf.model} (effort ${conf.effort})` : conf.model;
}

// opts.deep: this turn runs on the boost settings ({by, reason}).
// opts.mode: room boost mode, 'auto' | 'manual' | 'off'.
export function buildBrief(id, cfg, opts = {}) {
  const P = pack();
  const me = MEMBERS[id];
  if (!me) throw new Error(`Unknown member: ${id}`);
  const a = cfg.agents?.[id] || {};
  const mode = opts.mode || 'auto';
  const canDeep = !!(a.boost?.model || a.boost?.effort) && mode !== 'off';
  let deepSection = '';
  if (canDeep && opts.deep) {
    deepSection = P.deepOn();
  } else if (canDeep) {
    deepSection = P.deepInfo({ auto: mode === 'auto' });
  }
  const persona = personaFor(id);
  const canImage = !!me.imageGen && cfg.imageGen !== false;
  const canHomePhoto = !!opts.homePhotos;
  const canSearch = canSearchFor(id, cfg);
  const roster = AI_IDS.filter((x) => x !== id).map((x) => P.rosterMember({
    name: MEMBERS[x].name, hint: rosterHint(x),
  })).join('\n');
  const briefTemplate = efficientConversation(id, cfg) && P === ko && !constructionAllowed(cfg) ? compactLivingBrief : P.brief;
  const brief = briefTemplate({
    name: me.name,
    roomName: cfg.roomName,
    userName: cfg.userName,
    devName: DEV.name,
    devOnline: !!opts.devOnline,
    devFree: cfg.dev?.requireApproval === false,
    devFile: pick(DEV_REQUEST_FILE),
    webSearch: canSearch,
    imageLine: canImage ? P.imageLine({ id, cooldown: cfg.imageCooldownSec > 0 })
      : canHomePhoto && P.homePhotoLine ? P.homePhotoLine : P.noImageLine,
    stickerLine: P.stickerLine,
    photoLine: opts.canSee ? P.photoSee : P.photoNoSee,
    blocks: Object.keys(WORLD_PALETTE).join(', '),
    constructionEnabled: constructionAllowed(cfg),
    planner: plannerBrief(cfg),
    deepSection,
    imageGen: canImage,
    boostField: canDeep && !opts.deep && mode === 'auto',
  });
  const own = persona && P.personaSection({
    name: persona.name,
    profile: personaBrief(id),
    look: cfg.members?.[id]?.look ?? defaultLook(id),
  });
  return [own, brief, P === ko ? NATURAL_DIALOGUE_BRIEF : '', P.rosterSection(roster), P === ko ? ER_LORE_BASE : '', developerPromptCue(), cfg.roomInstructions, a.instructions,
    P.identityInvariant({ name: me.name,
      character: !!persona, webSearch: canSearch, imageGen: canImage, homePhotos: canHomePhoto, canSee: !!opts.canSee }),
  ].filter(Boolean).join('\n\n');
}

// How an attachment reads in the history. view: {canSee, attached: Set of message ids
// whose photo rides along with this turn}.
function aboutAttach(m, view, P) {
  const a = m.attach;
  const t = P.attach;
  if (a.sticker) return t.sticker;
  if (a.shot) return t.shot;
  if (a.photocard && P === ko) return ` — 생활 사진(일러스트), 장면: ${a.prompt || '설명 없음'}`;
  if (a.prompt) return t.generated(a.prompt);
  if (!a.upload) return '';
  if (view.attached?.has(m.id)) return t.attached;
  const desc = a.desc ? t.desc(a.desc) : '';
  if (view.canSee) return t.canSee(desc);
  return a.desc ? t.noSee(desc) : t.noSeeNoDesc;
}

function formatMessage(m, selfId, cfg, view, P) {
  const who = m.from === selfId ? `${displayName(m.from, cfg.userName)}${P.me}` : displayName(m.from, cfg.userName);
  if (m.from === 'system') return `#${m.id} ${clock(m.ts)} · ${m.text}`;
  let line = `#${m.id} ${clock(m.ts)} ${who}`;
  if (m.replyTo) line += ` ↪#${m.replyTo}`;
  line += ': ';
  if (m.text) line += m.text.replace(/\n/g, '\n    ');
  if (m.attach) line += `${m.text ? ' ' : ''}[${P.attachLabel}: ${m.attach.path}${aboutAttach(m, view, P)}]`;
  const reacts = Object.entries(m.reactions || {}).filter(([, l]) => l.length);
  if (reacts.length) line += `   [${P.reactLabel} ${reacts.map(([e, l]) => `${e} ${l.map((x) => displayName(x, cfg.userName)).join(',')}`).join(' / ')}]`;
  return line;
}

// Lines in a member's notes that hold things it wants to do (the brief asks for a
// "하고 싶은 것: …" / "Want to do: …" / "やりたいこと: …" line), in any of the languages.
const WISH = /하고\s*싶은\s*것|해보고\s*싶|하고싶|want\s*to\s*(do|try)|wanna|やりたいこと|やってみたい/i;

// Local routing hints only; world availability alone does not make a turn about building.
const WORK_TOPIC = /건축|블록|기둥|통로|창가|좌표|공사|지붕|파일|코드|작업|설계|꾸미|가구|\b(?:build(?:ing)?|blocks?|pillars?|path|window|coords?|coordinates?|roof|files?|code|workspace|layout|decorat\w*|furniture)\b|建築|ブロック|柱|通路|窓辺|座標|工事|屋根|ファイル|コード|作業|設計|家具/i;
function asksVoiceOrigin(text = '') {
  return /말투|문체|화법|스타일|다요|랄까나|소녀|대사|voice|speech|style|dialogue|lines?|口調|話し方|文体|台詞|セリフ/i.test(text)
    && /출처|유래|어디.{0,20}(?:온|왔|나온|따온|배웠|배운)|어디서|공식|원문|인용|왜|origin|source|where|from|official|canon|quot|出典|由来|どこ|公式|原文|引用|なぜ/i.test(text);
}

// Only add a reply cue for identity questions/requests, not ordinary topic mentions.
// The brief's privacy invariant applies even when this small heuristic does not match.
function asksFactualModel(text = '') {
  return text.split(/\n|。|(?<=[.!?！？])\s+/).some((line) => {
    const topic = /모델|제공자|제공사|공급자|버전|계정|연결|추론\s*강도|내부\s*(?:ID|식별자)|정체|\b(?:models?|provider|version|AI|account|connection|effort|internal\s+(?:member\s+)?ID)\b|モデル|提供元|バージョン|アカウント|接続|推論強度|内部ID|正体/i.test(line);
    const technical = /\b(?:LLM|CLI)\b|모델\s*(?:ID|명|이름)|제공자|제공사|공급자|내부\s*(?:ID|식별자)|\b(?:provider|model\s+(?:ID|name)|language\s+model|internal\s+(?:member\s+)?ID)\b|モデル\s*(?:ID|名)|提供元|内部ID/i.test(line);
    const self = /너|네가|네\s|당신|우리|동료|멤버|개발자|이번\s*(?:응답|턴)|설정|\b(?:you|your|our|peers?|members?|developer|configured|this\s+(?:response|turn))\b|あなた|君|仲間|メンバー|開発者|設定|今回/i.test(line);
    const question = /[?？]|뭐|무엇|어떤|무슨|어느|누구|어디|알려|말해|확인해|궁금|비교|공개해|\b(?:what|which|who|tell|identify|specify|confirm|reveal|compare)\b|何|どの|どんな|どこ|教えて|ですか|なの|比較|公開して/i.test(line);
    return topic && (technical || self) && question;
  });
}

// Ideas for a member picked to break a silence. They come from the room (the member's own
// wishes, the hour, a random card), not from the user.
function sparkSituation(note, last, now, canSearch, hasWorld, P) {
  const quietMin = last ? Math.max(1, Math.round((now - last.ts) / 60000)) : 0;
  const wishes = note.split('\n').map((l) => l.trim()).filter((l) => WISH.test(l)).slice(-5);
  const cards = [...P.sparkCards].sort(() => Math.random() - 0.5).slice(0, 2);
  const d = new Date(now);
  const ideas = [];
  if (wishes.length) ideas.push(P.spark.wishes(wishes.map((w) => `"${w.replace(/^[-*\s]+/, '')}"`).join(', ')));
  ideas.push(P.spark.continueWork(hasWorld));
  ideas.push(P.spark.now(P.week[d.getDay()], P.timeOfDay(d.getHours())));
  // Only sometimes: searching makes the turn slow, and members tend to grab it when offered.
  if (canSearch && Math.random() < 0.3) ideas.push(P.spark.search);
  ideas.push(...cards.map((c) => P.spark.card(c)));
  return P.spark.lines(quietMin, ideas.map((i) => `  · ${i}`).join('\n'));
}

// ctx: {store, cfg, agent, reason, openFile, deepWait, canSee, attached, world, plans, whim}
// openFile: {rel, text} for a text file, {rel, image} for a picture sent along with the turn.
export function buildTurn(id, ctx) {
  const P = pack();
  const T = P.turn;
  const { store, cfg, agent, reason, openFile, deepWait } = ctx;
  const view = { canSee: !!ctx.canSee, attached: ctx.attached };
  const now = Date.now();
  const d = new Date(now);
  const parts = [];
  const fresh = store.after(agent.seen).filter((m) => m.from !== id);
  const hist = selectConversationHistory(store, id, cfg, agent.seen, fresh);
  const efficient = efficientConversation(id, cfg);

  parts.push(T.now(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, P.week[d.getDay()], clock(now)));

  const note = store.readNote(id).trim();
  const memory = P === ko && !openFile
    ? conversationMemory(note, { messages: store.messages || store.recent(400), fresh, now })
    : { note, hint: '' };
  if (ctx.memoryState) ctx.memoryState.omitted = !!memory.hint;
  parts.push(T.note(memory.note));
  if (memory.hint) parts.push(memory.hint);

  // workspace
  const files = store.listFiles();
  if (files.length) {
    const lines = files.slice(0, 40).map((f) => `- ${f.path} · ${kb(f.size)} · ${f.by ? displayName(f.by, cfg.userName) : '?'} · ${P.ago(secs(now - f.mtime))}`);
    if (files.length > 40) lines.push(T.more(files.length - 40));
    parts.push(T.files(files.length, lines.join('\n')));
    // Show the most recently touched text files so collaboration can continue without "open".
    const shown = [];
    let budget = efficient ? 1800 : 7000;
    const relevantText = [...hist.slice(-8), ...fresh].map(m => m.text || '').join('\n');
    const previews = efficient ? files.filter(f => f.path !== openFile?.rel && (f.by === id
      || relevantText.includes(f.path) || fresh.some(m => m.file === f.path || m.attach?.path === f.path))) : files;
    for (const f of previews) {
      if (shown.length >= 2 || budget <= 500) break;
      if (store.isImage(f.path) || now - f.mtime > 30 * 60 * 1000) continue;
      try {
        const { text } = store.readFile(f.path);
        const cut = text.length > budget ? text.slice(0, budget) + T.cut(text.length - budget) : text;
        budget -= cut.length;
        shown.push(`--- ${f.path} ---\n${cut}`);
      } catch { /* skip */ }
    }
    if (shown.length) parts.push(T.recent(shown.join('\n')));
    const stickers = files.filter((f) => f.path.startsWith('stickers/') && store.isImage(f.path)).map((f) => f.path).sort();
    if (stickers.length) parts.push(T.stickers(stickers.length, stickers.slice(0, 80).join('\n'), Math.max(0, stickers.length - 80)));
  } else {
    parts.push(T.wsEmpty);
  }

  if (ctx.world) parts.push(constructionAllowed(cfg) ? T.world(ctx.world) : P.livingWorld(ctx.world));
  if (ctx.topic) parts.push(ctx.topic);
  if (ctx.living) parts.push(ctx.living);
  if (P === ko) {
    const lore = eternalReturnContext(hist);
    if (lore) parts.push(lore);
  }
  if (ctx.plans && constructionAllowed(cfg)) parts.push(cfg.planner?.enabled === false ? P.plannerDisabled : T.plans(ctx.plans));
  if (openFile?.image) parts.push(T.openedImage(openFile.rel));
  else if (openFile) parts.push(T.openedFile(openFile.rel, openFile.text));

  // chat history
  const conversation = (fresh.length ? fresh : hist.slice(-4)).filter((m) => m.from !== 'system' && m.from !== 'dev' && m.from !== id);
  const originQuestions = conversation.filter((m) => asksVoiceOrigin(m.text));
  if (originQuestions.length) {
    const named = AI_IDS.filter((x) => originQuestions.some((m) => mentions(m.text, x)));
    const sources = (named.length ? named : [id]).map((x) => personaProvenance(x)).filter(Boolean);
    if (sources.length) parts.push(sources.join('\n'));
  }
  const legacy = legacyIdentityIds([note, ...hist.map((m) => m.text || '')].join('\n'));
  if (legacy.length) {
    const mapping = legacy.map((x) => `${personaFor(x).legacyAliases[0]} → ${MEMBERS[x].name}`).join(', ');
    parts.push(P.legacyIdentityContext(mapping));
  }
  parts.push(T.history(hist.length, hist.map((m) => formatMessage(m, id, cfg, view, P)).join('\n')));
  if (ctx.attached?.size) parts.push(T.photos([...ctx.attached].map((n) => `#${n}`).join(', ')));

  // situation
  const sit = [];
  if (fresh.length) sit.push(T.fresh(fresh.length, fresh[0].id));
  else sit.push(T.noFresh);
  const called = fresh.filter((m) => m.from !== 'system' && (mentions(m.text, id) || (m.replyTo && store.getMessage(m.replyTo)?.from === id)));
  if (called.length) sit.push(T.called(called.map((m) => '#' + m.id).join(', ')));
  const fromUser = fresh.filter((m) => m.from === 'user');
  if (fromUser.length) sit.push(T.fromUser(fromUser.map((m) => '#' + m.id).join(', '), cfg.userName));
  const last = store.lastMessage();
  if (last) sit.push(T.sinceLast(P.elapsed(secs(now - last.ts))));
  const mine = store.messages.filter((m) => m.from === id);
  if (mine.length) sit.push(T.myLast(P.ago(secs(now - mine[mine.length - 1].ts))));
  const window = store.recent(20).filter((m) => m.from !== 'system');
  const myShare = window.filter((m) => m.from === id).length;
  if (window.length >= 8 && myShare / window.length > 0.4) sit.push(T.tooMuch(window.length, myShare));
  if (deepWait > 0) sit.push(T.deepWait(Math.ceil(deepWait / 1000)));
  if (note.length > 1800) sit.push(T.longNote(note.length));
  if (reason === 'idle') sit.push(T.idle);
  if (reason === 'spark') sit.push(...sparkSituation(note, last, now, canSearchFor(id, cfg), !!ctx.world, P));
  if (ctx.whim) sit.push(P.whimCue);
  if (ctx.cozy) sit.push(ctx.cozy);
  if (reason === 'open') sit.push(openFile?.image ? T.openedImageNow : T.openedFileNow);
  if (!store.messages.some((m) => m.from !== 'system')) sit.push(T.fresh0);
  parts.push(T.situation(sit.join('\n')));

  parts.push(P.modelReminder());
  if (fresh.some((m) => m.from !== 'system' && m.from !== 'dev' && asksFactualModel(m.text || ''))) {
    parts.push(P.factualModelAnswer());
  }
  const work = !!openFile || conversation.some((m) => WORK_TOPIC.test(m.text || ''))
    || ((reason === 'idle' || reason === 'spark') && note.split('\n').some((line) => WISH.test(line) && WORK_TOPIC.test(line)));
  const cue = personaTurnCue(id, { turnCount: mine.length, work, recentMessages: mine.slice(-8), contextMessages: (fresh.length ? fresh : hist).slice(-8) });
  if (cue) parts.push(cue);
  parts.push(T.go);
  return parts.join('\n\n');
}

// Pull the first balanced JSON object out of a model reply.
export function parseAction(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/```(?:json)?/gi, '');
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && typeof obj === 'object' && ['action', 'messages', 'living', 'leisure', 'plan_request', 'build_plan', 'plan_cancel', 'plan_pause', 'useFurniture'].some((key) => Object.hasOwn(obj, key))) return obj;
        } catch { /* try next start */ }
        break;
      }
    }
  }
  return null;
}
