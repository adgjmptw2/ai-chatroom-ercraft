// Local, bounded observations. No model calls, timers, writes or forced actions.
import { AI_IDS } from './members.mjs';
import { photoSubjectsArriving } from './cozy-chat.mjs';

const MINUTE = 60_000;
const FILLERS = /(?:아디나|비앙카|일레븐|루치아|소녀|진조|그대|랄까나|달까나|거다요|다요)/gu;
const COMMON = new Set(['그렇게','이렇게','그럼','그래도','그런데','그건','정말','조금','아직','지금','오늘','다시','그냥','같아','좋아','있는','나는','저는','너는','우리','기분','이야','말이','니까','답니','습니','어요','겠어','겠군','겠지','군요','어요','하지','하지요','하겠','겠답','그것','어라','때문','아하','하하','후후']);
for (const word of ['너무','진짜','생각','그렇','그러','나도','그래','있어','같은','내가','제가','이건','그게','해도','하면','하고','그런','이런']) COMMON.add(word);

function fragments(text) {
  const out = new Set();
  const words = String(text || '').slice(0, 600).normalize('NFKC').toLowerCase()
    .replace(/@[^\s]+/gu, '').replace(FILLERS, '').match(/[가-힣a-z]{2,}/gu) || [];
  for (const word of words.slice(0, 100)) {
    if (COMMON.has(word.slice(0, 2))) continue;
    // Prefixes survive Korean particles without matching characteristic endings.
    const prefix = word.slice(0, Math.min(3, word.length));
    if (!COMMON.has(prefix) && !COMMON.has(word)) out.add(prefix);
    if (word.length > 2 && !COMMON.has(word.slice(0, 2))) out.add(word.slice(0, 2));
  }
  return out;
}

// A hint, not a semantic verdict: the model still decides whether there is a
// genuinely new point. Host requests reset the window; no dialogue is removed.
export function repeatedConversation(messages, now = Date.now()) {
  const recent = messages.slice(-400);
  const lastHost = recent.findLastIndex(m => m.from === 'user' || m.from === 'dev');
  const chat = recent.slice(lastHost + 1).filter(m => AI_IDS.includes(m.from)
    && typeof m.text === 'string' && m.text.trim() && Number.isFinite(m.ts)
    && m.ts <= now && now - m.ts < 4 * 60 * MINUTE).slice(-120);
  // Slow conversations can repeat across long breaks. A stale, finished chat
  // alone must not trigger a cue after the room has already gone quiet.
  if (!chat.length || now - chat.at(-1).ts >= 25 * MINUTE) return false;
  if (chat.length < 18 || chat.at(-1).ts - chat[0].ts < 4 * MINUTE) return false;
  const farewells = chat.filter(m => /(?:잘\s*자|굿나잇|좋은\s*(?:밤|꿈)|이번엔\s*정말.{0,12}(?:눈|자|조용)|진짜\s*(?:자|잔다)|눈\s*감)/u.test(m.text));
  if (farewells.length >= 7 && new Set(farewells.map(m=>m.from)).size >= 2) return true;
  const counts = new Map();
  chat.forEach((m, i) => {
    for (const key of fragments(m.text)) {
      const v = counts.get(key) || { count: 0, old: 0, fresh: 0, speakers: new Set(), indices: new Set() };
      v.count++; v.old += i < chat.length / 2; v.fresh += i >= chat.length - 12;
      v.speakers.add(m.from); v.indices.add(i); counts.set(key, v);
    }
  });
  const recurring = [...counts].filter(([,v]) => v.count >= 8 && v.old >= 3 && v.fresh >= 3 && v.speakers.size >= 2);
  return recurring.some(([key, a], i) => recurring.slice(i + 1).some(([other, b]) =>
    !key.startsWith(other) && !other.startsWith(key)
    && [...a.indices].filter(index => b.indices.has(index)).length >= 6));
}

function signature(a) {
  return a && [a.x, a.y, a.z].every(Number.isFinite)
    ? JSON.stringify([a.x, a.y, a.z, a.posture || 'stand', a.furniture?.at || null]) : null;
}

function occupiedActivity(living, actor) {
  const meal = living?.meal, game = living?.game;
  return living?.unavailable || living?.pausedAt != null
    || meal && meal.status !== 'finished' && meal.cook === actor
    || game && game.status !== 'finished' && game.players?.includes(actor);
}

export function walkDestination(world, actor, sequence = 0) {
  if (typeof world.navigationPath !== 'function' || typeof world.occupiedAt !== 'function') return null;
  const areas = ['courtyard', 'north-maru', 'album', 'south-maru'];
  for (let n = 0; n < areas.length; n++) {
    const room = world.home?.rooms?.find(r => r.id === areas[(sequence + n) % areas.length]);
    const rect = room?.rectXZ;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isSafeInteger)) continue;
    const self = world.avatars[actor];
    if (!self) return null;
    // Search a reachable standing cell in the area, not its possibly blocked center.
    const route = world.navigationPath(self, p => p.x >= rect[0] && p.x < rect[2] && p.z >= rect[1] && p.z < rect[3]
      && Math.hypot(self.x-p.x,self.z-p.z)>=4 && !world.occupiedAt(actor,p));
    if (route?.length > 1) return { point: [route.at(-1).x,route.at(-1).z], name: room.name };
  }
  return null;
}

export class RoomRhythm {
  #positions = new Map();
  #last = null;
  #active = false;
  #motionAt = -Infinity;
  #topicAt = -Infinity;
  #topicActors = new Map();
  #ambientAt = -Infinity;

  // Called by the existing server tick. Four records at most. Room-off time,
  // sleep, clock jumps and long event-loop stalls never become hours of sitting.
  observe(world, { active, now = Date.now() }) {
    if (!Number.isSafeInteger(now) || now < 0) return;
    const elapsed = active && this.#active && this.#last !== null
      ? Math.max(0, Math.min(2000, now - this.#last)) : 0;
    this.#last = now; this.#active = !!active;
    for (const actor of AI_IDS) {
      const sig = signature(world?.avatars?.[actor]);
      if (!sig) { this.#positions.delete(actor); continue; }
      const old = this.#positions.get(actor);
      if (!old || sig !== old.signature) {
        this.#positions.set(actor, { signature: sig, elapsed: 0, offeredAt: old?.offeredAt ?? -Infinity,
          movedAt: old ? now : -Infinity, sequence: old?.sequence ?? AI_IDS.indexOf(actor) });
      } else old.elapsed += elapsed;
    }
  }

  allowSeatOffer(actor, now = Date.now()) {
    const pose = this.#positions.get(actor);
    return !pose || now - Math.max(pose.movedAt, pose.offeredAt) >= 12 * MINUTE;
  }

  ambientStep(world, { eligible = [], living = null, photoBusy = false, now = Date.now() } = {}) {
    if (!this.#active || photoBusy || now-this.#ambientAt < 4*MINUTE) return null;
    for (const actor of eligible) {
      if (!AI_IDS.includes(actor) || occupiedActivity(living,actor)) continue;
      const pose = this.#positions.get(actor);
      if (!pose || pose.elapsed < (18+AI_IDS.indexOf(actor)*3)*MINUTE
        || now-pose.offeredAt < 8*MINUTE || photoSubjectsArriving(world.avatarView(),[{id:actor}],now)) continue;
      pose.offeredAt=now; this.#ambientAt=now;
      const target=walkDestination(world,actor,pose.sequence++);
      return target ? {actor,point:target.point} : null;
    }
    return null;
  }

  hint(world, actor, { messages = [], living = null, photoBusy = false, hostPending = false,
    continuation = false, now = Date.now() } = {}) {
    if (!this.#active || continuation || hostPending || !AI_IDS.includes(actor)
      || occupiedActivity(living, actor)) return '';
    const pose = this.#positions.get(actor), avatar = world.avatars?.[actor];
    if (!pose || !avatar) return '';
    const arriving = photoSubjectsArriving(world.avatarView(), [{ id: actor }], now);
    if (arriving) return '';
    if (!photoBusy && avatar.posture !== 'lie' && pose.elapsed >= (8 + AI_IDS.indexOf(actor) * 2) * MINUTE
      && now - pose.offeredAt >= 20 * MINUTE && now - this.#motionAt >= 3 * MINUTE) {
      const spot = walkDestination(world, actor, pose.sequence++);
      // Even an unreachable house is checked only at the bounded offer cadence.
      pose.offeredAt = now; this.#motionAt = now;
      if (spot) return `한동안 같은 자리에 머물렀어요. 원하면 본인만 ${spot.name} 쪽 ${JSON.stringify({ move: spot.point })}로 잠깐 걸어가며 이야기를 이어가거나 혼자 쉬어도 좋아요. 행동만 선택하고 말은 쉬어도 돼요. 이동은 제안이며 그대로 있어도 괜찮고, 다른 사람까지 부르거나 바로 소파로 돌아갈 필요는 없어요. 실제로 이동하기 전에는 도착했다고 말하지 않아요.`;
    }
    if (now - this.#topicAt < 5 * MINUTE || now - (this.#topicActors.get(actor) ?? -Infinity) < 15 * MINUTE) return '';
    if (!repeatedConversation(messages, now)) return '';
    this.#topicAt = now; this.#topicActors.set(actor, now);
    return '최근 같은 소재와 반응이 여러 번 이어졌어요. 이어갈 새로운 내용이 있으면 말하고, 이미 나온 약속·칭찬·놀림을 표현만 바꿔 돌려주지는 않아요. 할 말이 없으면 반응만 하거나 pass해도 좋아요. 다른 관심사나 자기 생각을 툭 꺼내도 되고, 화제 전환을 선언하거나 새 질문·요리·게임·촬영을 억지로 만들 필요는 없어요. 방장의 요청과 아직 답하지 않은 질문은 먼저 챙겨요.';
  }
}
