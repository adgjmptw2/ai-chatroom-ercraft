// Optional photo ideas on existing turns. No movement, timer or provider call.
import { AI_IDS } from './members.mjs';
import { photoSubjectsArriving } from './cozy-chat.mjs';

const MINUTE = 60_000;
const HISTORY_LIMIT = 500, RECENT_MS = 3 * 60 * MINUTE;
const validTime = t => Number.isSafeInteger(t) && t >= 0;
const validPoint = a => a && [a.x, a.y, a.z].every(Number.isFinite)
  && a.x >= 0 && a.x < 48 && a.z >= 0 && a.z < 48 && a.y >= 0 && a.y < 34;
const zoneOf = (home, a) => [...(home?.rooms || []), ...(home?.commonRoomZones || [])].find(z =>
  Array.isArray(z.rectXZ) && a.x >= z.rectXZ[0] && a.z >= z.rectXZ[1]
  && a.x < z.rectXZ[2] && a.z < z.rectXZ[3])?.id;

// Only saved attachments are successes. Request prose, filenames and uploaders
// cannot identify the people in a photo. Older attachments stay unknown.
const savedImage = m => typeof m.attach?.path === 'string'
  && /\.(?:svg|png|jpe?g|webp)$/i.test(m.attach.path)
  && !m.attach.sticker && !m.attach.shot && !m.error && !m.attach.error
  && m.ok !== false && m.attach.ok !== false && !['error', 'drawing', 'request'].includes(m.kind)
  && [m.status, m.attach.status].every(s => s == null || ['success', 'completed', 'ready'].includes(s));
function photoSubjects(value) {
  if (!Array.isArray(value) || !value.length || value.length > AI_IDS.length
    || !Array.from(value).every(id => AI_IDS.includes(id))) return null;
  return AI_IDS.filter(id => value.includes(id)); // deduplicate and canonicalize, without mutating
}
const subjectKey = ids => AI_IDS.filter(id => ids.includes(id)).join(',');

// One bounded, read-only route search, only when an optional invitation is due.
// Invitations are not attendance: callers must re-observe real positions later.
export function photoMeetingPoint(world, actor, peers) {
  if (typeof world?.navigationPath !== 'function' || typeof world?.occupiedAt !== 'function') return null;
  const self = world.avatars?.[actor];
  if (!validPoint(self) || !peers.length) return null;
  const publicAreas = (world.home?.rooms || []).filter(r =>
    ['courtyard', 'gallery', 'common', 'album'].includes(r.kind)
    && Array.isArray(r.rectXZ) && r.rectXZ.length === 4 && r.rectXZ.every(Number.isFinite));
  const areaAt = p => publicAreas.find(r => zoneOf(world.home, p) === r.id);
  const anchors = peers.filter(id => validPoint(world.avatars?.[id]) && areaAt(world.avatars[id]));
  const common = publicAreas.find(r => r.id === 'courtyard') || publicAreas.find(r => r.kind === 'common');
  if (!anchors.length && !common) return null;
  const goal = p => validPoint(p) && !world.occupiedAt(actor, p) && (anchors.length
    ? anchors.some(id => areaAt(p)?.id === areaAt(world.avatars[id])?.id
      && Math.abs(p.y-world.avatars[id].y)<1 && Math.hypot(p.x-world.avatars[id].x,p.z-world.avatars[id].z)<=3)
    : areaAt(p)?.id === common.id);
  const route = world.navigationPath(self, goal), end = route?.at(-1);
  if (!end || !goal(end)) return null;
  const near = anchors.filter(id => areaAt(world.avatars[id])?.id === areaAt(end)?.id
    && Math.abs(end.y-world.avatars[id].y)<1 && Math.hypot(end.x-world.avatars[id].x,end.z-world.avatars[id].z)<=5);
  return { point: [end.x,end.z], place: areaAt(end).name, peers: near.length ? near : peers.slice(0,3) };
}

export class PhotoMoments {
  #settled = new Map();
  #offered = new Map();
  #lastOffer = -Infinity;
  #lastObserved = -Infinity;
  #meeting = null;
  #lastMeeting = -Infinity;
  constructor({ random = Math.random } = {}) { this.random = random; }

  hint({ home, avatars, actor, messages = [], lastPhotoAt = 0, available = false,
    hostPending = false, continuation = false, blocked = () => false, nameOf, onOffer, world,
    now = Date.now() } = {}) {
    if (!validTime(now) || !validTime(lastPhotoAt) || lastPhotoAt > now || !home || !AI_IDS.includes(actor)) return '';
    if (now < this.#lastObserved) {
      this.#settled.clear(); this.#offered.clear(); this.#lastOffer = -Infinity;
      this.#meeting = null; this.#lastMeeting = -Infinity;
    }
    this.#lastObserved = now;
    // Bounded to the four residents. Observe even during cooldown so ordinary
    // standing/working moments can settle without arranging a sofa gathering.
    for (const id of AI_IDS) {
      const a = avatars?.[id];
      if (!validPoint(a) || ['lie', 'sleep', 'sleeping', 'rest'].includes(a.posture)
        || blocked(id) || photoSubjectsArriving(avatars, [{ id }], now)) {
        this.#settled.delete(id); continue;
      }
      const key = JSON.stringify([a.x, a.y, a.z, a.posture]);
      const old = this.#settled.get(id);
      if (!old || old.key !== key || now < old.since) this.#settled.set(id, { key, since: now });
    }
    const ready = id => this.#settled.has(id) && now - this.#settled.get(id).since >= MINUTE;
    if (this.#meeting && now-this.#meeting.at >= 12*MINUTE) this.#meeting = null;
    if (!available || hostPending || continuation || !ready(actor)) return '';
    const self = avatars[actor], zone = zoneOf(home, self);
    if (!zone) return '';
    const close = AI_IDS.filter(id => id !== actor && ready(id)
      && zoneOf(home, avatars[id]) === zone && Math.abs(avatars[id].y - self.y) < 1
      && Math.hypot(avatars[id].x - self.x, avatars[id].y - self.y, avatars[id].z - self.z) <= 5);
    // A real arrival gets one normal-turn follow-up; an ignored invitation
    // cannot invent companions or repeatedly bypass the room's offer interval.
    const followup = this.#meeting?.actor === actor && close.some(id=>this.#meeting.peers.includes(id))
      && now-this.#meeting.at >= MINUTE;
    if (now-this.#lastOffer < (followup ? MINUTE : 3*MINUTE)
      || !followup && now-(this.#offered.get(actor) ?? -Infinity)<12*MINUTE) return '';

    const residentMessages = (Array.isArray(messages) ? messages.slice(-HISTORY_LIMIT) : [])
      .filter(m => m && AI_IDS.includes(m.from) && validTime(m.ts) && m.ts <= now);
    const actors = new Map(AI_IDS.map(id => [id, 0])), appearances = new Map(actors);
    const combinations = new Map(), photos = new Set();
    const compositions = [];
    let lastSuccess = lastPhotoAt;
    for (let i = residentMessages.length - 1; i >= 0; i--) {
      const m = residentMessages[i];
      if (m.attach?.photocard !== true || !savedImage(m) || /\.svg$/i.test(m.attach.path)) continue;
      lastSuccess = Math.max(lastSuccess, m.ts);
      if (photos.has(m.attach.path)) continue;
      photos.add(m.attach.path);
      const ids = photoSubjects(m.attach.photoSubjects);
      if (now-m.ts < 12*60*MINUTE && compositions.length<4) compositions.push(ids?.length ?? null);
      if (now - m.ts >= RECENT_MS) continue;
      // Age down old successes smoothly. The author is known independently of
      // the subjects, and must never be substituted for missing subject data.
      const weight = 1 - (now - m.ts) / RECENT_MS;
      actors.set(m.from, actors.get(m.from) + weight);
      if (!ids) continue;
      for (const id of ids) appearances.set(id, appearances.get(id) + weight);
      const key = subjectKey(ids);
      combinations.set(key, (combinations.get(key) || 0) + weight);
    }
    const since = lastSuccess || residentMessages.reduce((first, m) => Math.min(first, m.ts), Infinity);
    if (!Number.isFinite(since)) return '';
    // Reposting one drawing is not new variety. Count unique non-photo visual
    // files, never text promises or failed requests, in a small recent window.
    const drawings = new Set(residentMessages.filter(m => m.ts > lastSuccess && now - m.ts < RECENT_MS
      && !m.attach?.photocard && savedImage(m)).map(m => m.attach.path));
    const gap = (drawings.size >= 2 ? 25 : 35) * MINUTE;
    if (now - since < gap) return '';

    const nearby = [actor, ...close];
    // Yield to an actually available nearby photographer, never to somebody
    // sleeping, absent or in a different room. Ignored offers are not successes.
    const offerChance = Math.max(.2, 1 / (1 + actors.get(actor) - Math.min(...nearby.map(id => actors.get(id)))));
    const roll = this.random();
    if (!Number.isFinite(roll) || roll < 0 || roll >= offerChance) return '';
    const soloStreak = compositions.length>=2 && compositions[0]===1 && compositions[1]===1;
    // Offer a voluntary approach before falling back to another isolated shot.
    // Sleeping/resting/working residents remain excluded by the caller's gate.
    if (!close.length && now-this.#lastMeeting>=20*MINUTE && (soloStreak || roll/offerChance<.7)) {
      const peers=AI_IDS.filter(id=>id!==actor&&ready(id));
      const meeting=peers.length ? photoMeetingPoint(world,actor,peers) : null;
      if(meeting){
        this.#meeting={actor,peers:[...meeting.peers],at:now}; this.#lastMeeting=now;
        this.#lastOffer=now; this.#offered.set(actor,now);
        try{onOffer?.({subjects:[actor,...meeting.peers],kind:'meet',at:now});}catch{}
        return `최근 사진이 혼자 찍은 모습으로 이어지거나 서로 떨어져 있어요. 원하면 ${meeting.peers.map(nameOf).join(', ')}에게 같이 한 장 남길지 가볍게 물어보고, 본인만 ${meeting.place} 쪽 ${JSON.stringify({move:meeting.point})}로 다가가도 좋아요. 이번 턴에는 촬영하지 않고, 다음 평소 대화 차례에 실제로 가까이 있고 도착한 사람만 subjects에 넣어 찍어요. 초대는 참석·동의가 아니며 다른 사람을 이동시키거나 자는 사람을 깨우지 않아요. 둘이 찍어도, 셋·넷이 자연스럽게 모여 찍어도 좋고 거절하거나 다른 이야기를 해도 괜찮아요. 준비나 초대를 반복할 필요는 없어요.`;
      }
    }
    const groups = [[], [], []];
    // Four residents mean at most 15 combinations, all local to this call.
    // The speaker can photograph someone else without being in the picture.
    for (let mask = 1; mask < 1 << nearby.length; mask++) {
      const ids = nearby.filter((id, i) => mask & (1 << i));
      const seen = ids.reduce((sum, id) => sum + appearances.get(id), 0) / ids.length;
      const repeats = combinations.get(subjectKey(ids)) || 0;
      groups[Math.min(ids.length, 3) - 1].push({ ids, novelty: 1 / ((1 + seen) * (1 + 2 * repeats)) });
    }
    // With all sizes available and no known subjects: soft 20/50/30. Normalize
    // over real scenes so an impossible group does not suppress a valid moment.
    // Nearby candid subjects and success weights, not forced group sizes, supply variety.
    const sizeWeights=followup ? [0,.6,.4] : soloStreak ? [.08,.50,.42] : [.20,.50,.30];
    const choices = groups.flatMap((group, i) => group.length
      ? group.map(({ ids, novelty }) => ({ ids, weight: sizeWeights[i] * novelty / group.length }))
      : []);
    let pick = roll / offerChance * choices.reduce((sum, c) => sum + c.weight, 0);
    const chosen = choices.find(c => (pick -= c.weight) < 0) || choices.at(-1);
    if (!chosen.ids.length) return '';
    const subjects = chosen.ids.map(nameOf);
    const image = { photocard: true, subjects, style: 'snapshot', effort: 'medium', prompt: '지금 실제 자리와 자세에서 보내는 순간을 캐릭터 외형을 살린 귀여운 2D 생활 사진으로' };
    const hint = `사진으로 남긴 일상이 한동안 없어요${drawings.size >= 2 ? '. 최근에는 그림·디자인이 이어졌어요' : ''}. 마음에 드는 순간이면 ${subjects.join(', ')}의 지금 모습을 한 장 남겨도 좋아요. 예: ${JSON.stringify({ image })}. 장면 설명은 지금 대화와 실제 상태에 맞게 골라요. ${subjects.length>1 ? '지금 함께 있는 이 사람들을 subjects에 모두 적고, 각자의 표정·대화가 보이는 한 장면으로 남겨도 좋아요. 촬영하는 본인 한 명으로 줄일 필요는 없어요.' : '혼자 있는 순간도 좋고, 다음에는 깨어 있는 친구에게 같이 찍자고 제안해도 좋아요.'} 모두 앉히거나 네 명을 반드시 모을 필요는 없어요. SVG 낙서로 사진을 대신하지 말고 공용 image 기능을 써요. 이번에는 넘기거나 다른 활동을 해도 괜찮아요. 요청은 완료가 아니므로 첨부 전에는 찍었다고 말하지 마세요.`;
    this.#lastOffer = now; this.#offered.set(actor, now);
    if(followup)this.#meeting=null;
    // Optional diagnostics must not turn an otherwise valid hint into an error.
    try { onOffer?.({ subjects: [...chosen.ids], kind: subjects.length === 1 ? 'solo' : subjects.length === 2 ? 'pair' : 'group', at: now }); } catch {}
    return hint;
  }
}
