// One instance per room, observed only during ordinary conversation turns.
// No world writes, actions, timers, persistence, or provider calls.
const SOFAS = ['sofa-1', 'sofa-2', 'sofa-3', 'sofa-4'];
const MAX_OFFERS = 64, MAX_ID = 128, STABLE_MS = 60_000;
const point = p => p && [p.x, p.y, p.z].every(Number.isFinite);
const sameAt = (a, b) => Array.isArray(a) && a.length === 3 && a.every((n, i) => n === b[i]);
const adjacent = (a, b) => a.at[1] === b.at[1]
  && Math.abs(a.at[0] - b.at[0]) + Math.abs(a.at[2] - b.at[2]) === 1;
const identifier = id => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID;

function movement(world, id, avatar) {
  const stored = world.movements?.get(id);
  // World invalidates old routes by replacing the avatar object.
  return stored?.avatar === avatar ? stored : avatar;
}

function arriving(move, now) {
  if (move.moveId === undefined && move.path === undefined) return false;
  if (!Number.isSafeInteger(move.moveId) || move.moveId < 0
    || !Array.isArray(move.path) || !move.path.length || move.path.length > 256) return true;
  let distance = 0;
  for (let i = 0; i < move.path.length; i++) {
    const p = move.path[i], prev = move.path[i - 1];
    if (!point(p)) return true;
    if (prev) distance += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
  }
  // The renderer walks at four cells/second, including vertical transitions.
  return now < move.moveId + distance * 250 + 1_000;
}

// Share the visual-arrival rule with photo admission. avatarView() already
// removes obsolete routes, so a same-turn sit cannot be photographed mid-walk.
export function photoSubjectsArriving(avatars, subjects, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) return true;
  return subjects.some(({ id }) => avatars?.[id] && arriving(avatars[id], now));
}

function busy(state, actor) {
  const meal = state?.meal, game = state?.game;
  return Boolean(state?.unavailable || state?.pausedAt != null
    || meal && meal.status !== 'finished' && (meal.cook === actor || meal.eatenBy?.includes(actor))
    || game && game.status !== 'finished' && game.players?.includes(actor));
}

function actualSeats(world) {
  const seats = [];
  if (typeof world?.furniturePose !== 'function') return seats;
  for (const id of SOFAS) {
    const f = world.home?.furniture?.[id];
    if (f?.shape !== 'bench' || !Array.isArray(f.at) || f.at.length !== 3
      || !f.at.every(Number.isSafeInteger)) continue;
    const pose = world.furniturePose(f.at);
    if (!pose || pose.error || pose.shape !== 'bench' || pose.posture !== 'sit' || !point(pose)
      || pose.x !== f.at[0] || pose.z !== f.at[2]
      || typeof pose.block !== 'string' || pose.block.length > 128
      || world.blocks?.get(f.at.join(',')) !== pose.block
      || seats.some(s => sameAt(f.at, s.at))) continue;
    seats.push({ id, at: [...f.at], pose, occupied: false, settled: null, moving: false });
  }
  return seats;
}

function clusters(seats) {
  const remaining = new Set(seats), groups = [];
  while (remaining.size) {
    const group = [remaining.values().next().value];
    remaining.delete(group[0]);
    for (let i = 0; i < group.length; i++) for (const seat of remaining) {
      if (adjacent(group[i], seat)) { group.push(seat); remaining.delete(seat); }
    }
    groups.push(group.sort((a, b) => a.id.localeCompare(b.id)));
  }
  return groups;
}

export class CozyChatHints {
  // At most 64 actor/combo keys (IDs <=128 chars, at most four seats).
  // Oldest offers are forgotten on overflow; no avatar/world references survive.
  #offers = new Map();
  // At most four physical clusters, each with one bounded signature and clock.
  #photos = new Map();

  hint(world, actor, { living = null, nameOf = id => id, now = Date.now(), photoAvailable = false, allowSeatOffer = true } = {}) {
    if (!Number.isSafeInteger(now) || now < 0) { this.#photos.clear(); return ''; }
    const seats = actualSeats(world), avatars = world?.avatars || {};
    for (const seat of seats) {
      let occupants = 0;
      for (const [id, avatar] of Object.entries(avatars)) {
        if (!avatar) continue;
        const f = avatar.furniture;
        // Match World's conservative reservation rule, even for standing or
        // arriving occupants; stale links must never make a seat look free.
        if (!sameAt(f?.at, seat.at) && !(avatar.x === seat.pose.x && avatar.z === seat.pose.z
          && Math.abs((avatar.y ?? 1) - seat.pose.y) < 1.5)) continue;
        occupants++;
        seat.occupied = true;
        const move = movement(world, id, avatar), moving = arriving(move, now);
        seat.moving ||= moving;
        if (!moving && identifier(id) && sameAt(f?.at, seat.at) && f.shape === 'bench'
          && f.block === seat.pose.block && avatar.posture === 'sit'
          && avatar.x === seat.pose.x && avatar.y === seat.pose.y && avatar.z === seat.pose.z) {
          seat.settled = { id, moveId: move.moveId ?? null };
        }
      }
      if (occupants !== 1) seat.settled = null;
    }

    // Observe even when this caller cannot receive a hint. Availability and
    // actor turn order neither start nor consume the shared photo opportunity.
    const photos = new Map();
    for (const group of clusters(seats)) {
      const settled = group.filter(s => s.settled);
      if (settled.length < 2 || group.some(s => s.moving || s.occupied && !s.settled)) continue;
      const key = JSON.stringify(group.map(s => [s.id, s.at, s.pose.block, s.settled]));
      const old = this.#photos.get(key);
      const state = old && now >= old.lastSeen ? { ...old, lastSeen: now }
        : { since: now, lastSeen: now, offered: false };
      photos.set(key, state);
    }
    this.#photos = photos;

    const self = Object.hasOwn(avatars, actor) && avatars[actor];
    const state = typeof living?.view === 'function' ? living.view() : living;
    if (!identifier(actor) || !self || busy(state, actor) || arriving(movement(world, actor, self), now)) return '';
    const name = id => Array.from(String(nameOf(id) ?? '멤버').replace(/\s+/gu, ' ').trim()).slice(0, 24).join('') || '멤버';

    if (photoAvailable === true && self.posture === 'sit') {
      for (const group of clusters(seats)) {
        const settled = group.filter(s => s.settled);
        if (!settled.some(s => s.settled.id === actor)) continue;
        const key = JSON.stringify(group.map(s => [s.id, s.at, s.pose.block, s.settled]));
        const photo = this.#photos.get(key);
        if (!photo || photo.offered || now - photo.since < STABLE_MS) continue;
        const names = settled.map(s => name(s.settled.id)).join(', ');
        photo.offered = true;
        return `원하면 지금 소파에 앉아 있는 ${names}의 모습을 함께 사진 한 장으로 남겨도 좋아요. 지금 자리와 대화 그대로, 촬영 여부는 자유예요.`;
      }
    }

    if (!allowSeatOffer || (self.posture ?? 'stand') !== 'stand' || self.furniture) return '';
    const companions = seats.filter(s => s.settled && s.settled.id !== actor);
    const seat = seats.find(s => !s.occupied && companions.some(other => adjacent(s, other)));
    if (!seat) return '';
    const combo = JSON.stringify([actor, companions.map(s => [s.id, s.at, s.settled.id])]);
    if (this.#offers.has(combo)) return '';
    const neighbor = companions.find(other => adjacent(seat, other));
    const text = `${name(neighbor.settled.id)} 옆 소파에 빈자리가 있어요. 원하면 본인만 ${JSON.stringify({ living: { op: 'relax', spot: seat.id } })}로 앉아 대화를 이어가도 좋아요. 그대로 이야기해도 괜찮아요.`;
    this.#offers.set(combo, true);
    if (this.#offers.size > MAX_OFFERS) this.#offers.delete(this.#offers.keys().next().value);
    return text;
  }
}
