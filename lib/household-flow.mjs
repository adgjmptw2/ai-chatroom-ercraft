// Small resident commitments, evaluated on existing turns/ticks. No model calls.
import { AI_IDS } from './members.mjs';
import { photoSubjectsArriving } from './cozy-chat.mjs';
import { walkDestination } from './room-rhythm.mjs';

const M = 60_000;
export const LEISURE = Object.freeze({
  sleep: { label: '잠깐 잠들기', minutes: 40, min: 15, max: 60 },
  rest: { label: '조용히 쉬기', minutes: 12, min: 5, max: 30 },
  write: { label: '이어쓰기·시·짧은 대본', minutes: 6, min: 2, max: 15 },
  draw: { label: '낙서·그림·작은 디자인', minutes: 6, min: 2, max: 15 },
  read: { label: '앨범·친구의 글 구경', minutes: 8, min: 2, max: 15 },
  music: { label: '음악 취향·가사 대신 자기 감상', minutes: 5, min: 2, max: 15 },
  walk: { label: '중정·툇마루 산책', minutes: 3, min: 2, max: 15 },
  tidy: { label: '주변 정돈·취미 준비', minutes: 4, min: 2, max: 15 },
});
const OWN_ROOM = { gpt: 'adina', claude: 'eleven', gemini: 'bianca', deepseek: 'lucia' };
const QUIET = new Set(['rest', 'sleep']);
const finiteTime = value => Number.isSafeInteger(value) && value >= 0;
export function leisureRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(LEISURE, value.kind)) return null;
  const spec = LEISURE[value.kind], minutes = value.minutes ?? spec.minutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return { kind: value.kind, minutes: Math.max(spec.min, Math.min(spec.max, Math.round(minutes))) };
}

// Only first-person, immediate commitments. A greeting/question/quotation is not consent to sleep.
export function restIntent(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim().slice(-400);
  if (/[?？]|["'‘’“”「」]|(?:내일|아침에|나중에|언젠가|끝나면|끝내면|다음에|뒤에|후에|나서).{0,40}(?:잘|자|잠|쉬|쉴|눈)|(?:(?:안|못)\s*(?:자|잘|쉬|쉴)|잠이\s*안|자지\s*않)/u.test(value)) return null;
  const self = /(?:나도|나는|난\s|저도|저는|소녀도|소녀는|이\s*몸도|이\s*몸은|이번엔|이번에는|이제|오늘은)/u.test(value);
  if (!self) return null;
  if (/(?:잘게|잘래|잔다|자야겠다|잠들겠|잠들러|눈\s*(?:좀\s*)?감(?:을게|겠|는답|으려))/u.test(value)) return 'sleep';
  if (/(?:쉬겠|쉬러\s*(?:갈|가)|쉬고\s*올|혼자\s*좀\s*있|조용히\s*있겠)/u.test(value)) return 'rest';
  return null;
}

export function busyHousehold(living, actor) {
  const state = typeof living?.view === 'function' ? living.view() : living;
  return !!(state?.unavailable || state?.pausedAt != null
    || state?.meal && state.meal.status !== 'finished' && state.meal.cook === actor
    || state?.game && state.game.status !== 'finished' && state.game.players?.includes(actor));
}

export function enterLeisure(world, actor, kind, { living = null, now = Date.now(), sequence = 0 } = {}) {
  if (!AI_IDS.includes(actor) || !Object.hasOwn(LEISURE, kind) || !world?.avatars?.[actor]) return { ok: false, error: 'invalid' };
  if (busyHousehold(living, actor) || photoSubjectsArriving(world.avatarView(), [{ id: actor }], now)) return { ok: false, error: 'busy' };
  const own = OWN_ROOM[actor], choices = {
    sleep: [`${own}-bed`], rest: [`${own}-chair`, ...[24,25,26,27].map(x => `courtyard-bench-${x}`)],
    write: [`${own}-desk`], draw: ['album-table-33','album-table-34',`${own}-desk`],
    read: ['album-bench-33','album-bench-34','album-bench-35',`${own}-chair`],
    music: [`${own}-chair`], tidy: ['laundry',`${own}-desk`],
  };
  if (kind === 'walk') {
    const target = walkDestination(world, actor, sequence);
    return target && world.move(actor, target.point) ? { ok: true, destination: target.name } : { ok: false, error: 'unreachable' };
  }
  for (const id of choices[kind] || []) {
    const f = world.home?.furniture?.[id];
    if (!f) continue;
    const result = world.useFurniture(actor, f.at);
    if (result.ok) return { ok: true, destination: f.name };
  }
  return { ok: false, error: 'unavailable' };
}

export class HouseholdFlow {
  #residents = new Map();
  #offers = new Map();
  #offerAt = -Infinity;
  constructor(saved) {
    if (saved === undefined) return;
    if (!saved || saved.version !== 1 || !saved.residents || typeof saved.residents !== 'object' || Array.isArray(saved.residents)) throw Error('Invalid household flow state');
    for (const id of AI_IDS) {
      const item = saved.residents[id]; if (item === undefined) continue;
      if (!item || item.kind !== null && !Object.hasOwn(LEISURE, item.kind)
        || !finiteTime(item.startedAt) || !finiteTime(item.until) || item.until < item.startedAt || item.until - item.startedAt > 60*M
        || !Array.isArray(item.recent) || item.recent.length > 6
        || item.recent.some(r => !r || !Object.hasOwn(LEISURE,r.kind) || !finiteTime(r.at))) throw Error('Invalid resident commitment');
      this.#residents.set(id, structuredClone(item));
    }
  }
  snapshot() { return { version: 1, residents: Object.fromEntries([...this.#residents].map(([id,v]) => [id,structuredClone(v)])) }; }
  phase(id, now = Date.now()) { const r = this.#residents.get(id); return r && r.until > now ? r.kind : null; }
  remaining(id, now = Date.now()) { const r = this.#residents.get(id); return r?.kind ? Math.max(0, r.until-now) : 0; }
  quietWait(id, kind, now = Date.now()) {
    if (!QUIET.has(kind)) return 0;
    const r=this.#residents.get(id);
    if (!r) return 0;
    // Persisted history is already bounded to six real actions. Silence is not
    // another nap: leave awake time between autonomous quiet commitments.
    const quiet=r.recent.filter(x=>QUIET.has(x.kind)).at(-1);
    const sleep=r.recent.filter(x=>x.kind==='sleep').at(-1);
    return Math.max(0,quiet ? quiet.at+90*M-now : 0,
      kind==='sleep'&&sleep ? sleep.at+4*60*M-now : 0,
      QUIET.has(this.phase(id,now)) ? r.until-now : 0);
  }
  canStart(id, request, now = Date.now()) {
    const valid=leisureRequest(request);
    return !!(AI_IDS.includes(id)&&valid&&finiteTime(now)&&!this.quietWait(id,valid.kind,now));
  }
  start(id, request, now = Date.now()) {
    const valid = leisureRequest(request); if (!AI_IDS.includes(id) || !valid || !finiteTime(now)) return false;
    if (!this.canStart(id,valid,now)) return false;
    const recent = this.#residents.get(id)?.recent || [];
    this.#residents.set(id, { kind: valid.kind, startedAt: now, until: now+valid.minutes*M,
      recent: [...recent,{kind:valid.kind,at:now}].slice(-6) });
    return true;
  }
  interrupt(id) { const r = this.#residents.get(id); if (!r?.kind) return false; r.kind = null; return true; }
  expire(now = Date.now()) {
    let changed = false;
    for (const r of this.#residents.values()) if (r.kind && now >= r.until) { r.kind = null; changed = true; }
    return changed;
  }
  blocks(id, { directHost = false, peerCalled = false, now = Date.now() } = {}) {
    const kind = this.phase(id, now); if (!kind || directHost) return false;
    const r = this.#residents.get(id);
    return QUIET.has(kind) || !peerCalled || now-r.startedAt < 2*M;
  }
  context(actor, nameOf, now = Date.now()) {
    const active = AI_IDS.filter(id => this.phase(id,now));
    const lines = active.map(id => `${nameOf(id)}: ${LEISURE[this.phase(id,now)].label} 중`);
    const last = this.#residents.get(actor)?.recent.at(-1);
    return [lines.length ? `각자의 시간: ${lines.join(' / ')}. 다른 사람의 활동은 답변이나 취침 인사를 요구하지 않아요.` : '',
      !this.phase(actor,now)&&this.quietWait(actor,'rest',now)>0
        ? '최근 휴식 상태는 끝났고 지금은 깨어 있어요. 곧바로 잠·휴식 시간을 다시 예약하지 않아요. 말없이 구경하거나 pass해도 깨어 있는 시간이 이어져요. 대화·작업·가벼운 이동은 원할 때만 골라요.'
        : !this.phase(actor,now)&&this.quietWait(actor,'sleep',now)>0
          ? '최근에 잠을 잤어요. 새로운 수면을 바로 예약하지 않고, 말없이 구경하거나 자기 생각을 해도 좋아요.'
          : last && !this.phase(actor,now) && now-last.at < 90*M ? `최근 본인이 고른 일은 ${LEISURE[last.kind].label}였어요. 이어갈 생각이 있으면 이어가고, 없으면 깨어서 조용히 구경해도 좋아요.` : ''].filter(Boolean).join('\n');
  }
  offer(actor, { now = Date.now(), hostPending = false } = {}) {
    if (!AI_IDS.includes(actor) || hostPending || this.phase(actor,now) || now-this.#offerAt < 3*M
      || now-(this.#offers.get(actor) ?? -Infinity) < 22*M) return '';
    this.#offers.set(actor, now); this.#offerAt = now;
    const kinds = ['write','draw','read','music','walk','tidy'];
    const recent = [...this.#residents.values()].flatMap(r=>r.recent).filter(r=>now-r.at<120*M);
    const own = this.#residents.get(actor)?.recent.at(-1)?.kind;
    const offset = (AI_IDS.indexOf(actor)+Math.floor(now/(22*M)))%kinds.length;
    const ordered = [...kinds.slice(offset),...kinds.slice(0,offset)].sort((a,b)=>
      recent.filter(r=>r.kind===a).length+(a===own?3:0)-recent.filter(r=>r.kind===b).length-(b===own?3:0));
    return `하고 싶은 일이 생기면 ${ordered.slice(0,3).map(kind=>`${LEISURE[kind].label} ${JSON.stringify({leisure:{kind}})}`).join(' / ')} 같은 선택도 있어요. 자유롭게 고르거나 잡담·pass를 해도 돼요. 글·그림은 files로 작은 결과를 실제 저장할 때만 완성했다고 말해요. 같은 활동을 매번 반복하거나 모두를 참가시킬 필요는 없어요.`;
  }
}
