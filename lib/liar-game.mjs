import { randomInt as secureRandomInt } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MINUTE = 60_000;
const LEAD = 10 * MINUTE, CADENCE = 6 * 60 * MINUTE, GRACE = 10 * MINUTE;
const GAP = 12_000, CLAIM_TTL = 3 * MINUTE, ROUND_TTL = 20 * MINUTE;
const PLAYERS = ['adina', 'bianca', 'eleven', 'lucia'];
const MAX_BYTES = 64 * 1024;
const CANCEL = '이번 게임은 진행을 이어가기 어려워 여기서 마칩니다. 다음 일정에 다시 만나요.';
const DECLINE = '참여자의 선택에 따라 이번 게임을 마쳤습니다. 다음 일정에 다시 만나요.';
const SKIP = '이번 예정 게임은 쉬어갑니다. 다음 일정에 다시 만나요.';
const DONE = '이번 라이어 게임이 끝났습니다. 결과를 확인해 주세요.';

// Self-authored, ordinary objects; categories intentionally cover several possible words.
// This bank and all role/claim data stay in this server-only module/private file.
const BANK = [
  ['우산', '생활용품', 'umbrella'], ['수건', '생활용품', 'towel'],
  ['거울', '생활용품', 'mirror'], ['베개', '생활용품', 'pillow'],
  ['담요', '생활용품', 'blanket'], ['비누', '생활용품', 'soap'],
  ['칫솔', '생활용품', 'toothbrush'], ['시계', '생활용품', 'clock'],
  ['가방', '생활용품', 'bag'], ['빗', '생활용품', 'comb'],
  ['연필', '문구', 'pencil'], ['지우개', '문구', 'eraser'],
  ['공책', '문구', 'notebook', '노트'], ['가위', '문구', 'scissors'],
  ['풀', '문구', 'glue'], ['스테이플러', '문구', 'stapler'],
  ['색연필', '문구', 'colored pencil', 'colour pencil'], ['봉투', '문구', 'envelope'],
  ['책갈피', '문구', 'bookmark'], ['달력', '문구', 'calendar'],
  ['숟가락', '주방용품', 'spoon'], ['젓가락', '주방용품', 'chopsticks'],
  ['접시', '주방용품', 'plate'], ['냄비', '주방용품', 'pot'],
  ['주전자', '주방용품', 'kettle'], ['도마', '주방용품', 'cutting board'],
  ['국자', '주방용품', 'ladle'], ['컵', '주방용품', 'cup'],
  ['프라이팬', '주방용품', 'frying pan', '후라이팬'], ['앞치마', '주방용품', 'apron'],
  ['사과', '과일', 'apple'], ['바나나', '과일', 'banana'],
  ['포도', '과일', 'grape'], ['딸기', '과일', 'strawberry'],
  ['수박', '과일', 'watermelon'], ['복숭아', '과일', 'peach'],
  ['레몬', '과일', 'lemon'], ['귤', '과일', 'tangerine'],
  ['체리', '과일', 'cherry'], ['파인애플', '과일', 'pineapple'],
  ['장갑', '의류', 'gloves'], ['목도리', '의류', 'scarf'],
  ['모자', '의류', 'hat'], ['양말', '의류', 'socks'],
  ['운동화', '의류', 'sneakers'], ['셔츠', '의류', 'shirt'],
  ['재킷', '의류', 'jacket', '자켓'], ['바지', '의류', 'trousers', 'pants'],
].map(([word, category, ...aliases], id) => ({ id, word, category, aliases: [word, ...aliases] }));

function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').normalize('NFKC');
}
function cleanText(text) {
  return typeof text === 'string' && text.trim().length > 0 && [...text].length <= 240 &&
    !/[\p{Cc}\p{Cs}]/u.test(text) && normalize(text).length > 0;
}
function leaks(text, wordId) {
  // Keep lexical boundaries. Only singleton spelling fragments may bridge separators;
  // ordinary words must never be joined into an accidental answer.
  const tokens = text.normalize('NFKC').toLowerCase().replace(/\p{Cf}/gu, '').match(/[\p{L}\p{N}]+/gu) || [];
  // Korean particles, conjugations and compounds can expose an answer too.
  // Exempt only recognizable unrelated words, not arbitrary suffixes.
  const unrelated = {
    모자: /^(?:모자라(?:다|요|서|면|지|지만)|모자랐[가-힣]*|모자람)$/u,
    빗: /^빗(?:나[가갔갈간][가-힣]*|소리[가-힣]*|물[가-힣]*)$/u,
    풀: /^풀(?:어[가-힣]*|었[가-힣]*|려[가-힣]*|렸[가-힣]*|다|고|면|린|릴)$/u,
    사과: /^사과(?:하다|해[가-힣]*|할게[가-힣]*|합니다|했[가-힣]*|하겠[가-힣]*)$/u,
  };
  const english = (value, word) => value === word || value === word+'s' || value === word+'es'
    || word.endsWith('y') && value === word.slice(0,-1)+'ies'
    || word.endsWith('f') && value === word.slice(0,-1)+'ves';
  return BANK[wordId].aliases.some(alias => {
    const secret = normalize(alias);
    const words = alias.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu);
    const matches = value => /^[가-힣]+$/u.test(secret)
      ? value.includes(secret) && !(value.indexOf(secret) === value.lastIndexOf(secret) && unrelated[secret]?.test(value))
      : english(value, secret);
    for (let i = 0; i < tokens.length; i++) {
      if (words.length > 1 && words.every((word, offset) => offset === words.length-1
        ? english(tokens[i + offset], word) : tokens[i + offset] === word)) return true;
      if (matches(normalize(tokens[i]))) return true;
      let joined = '';
      for (let j = i; j < tokens.length && j < i + secret.length * 3; j++) {
        joined += tokens[j];
        const fragment = normalize(joined);
        if (!secret.startsWith(fragment) && !fragment.startsWith(secret)) break;
        if (j > i && matches(fragment)) return true;
        if ([...tokens[j]].length !== 1) break;
      }
    }
    return false;
  });
}
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function timestamp(value) {
  if (!integer(value) || value > Number.MAX_SAFE_INTEGER - 2 * CADENCE) throw new Error('Invalid game time');
  return value;
}
function actorFor(round) {
  return round.status !== 'active' ? null : round.phase === 'guess' ? round.liar : round.players[round.step % 4];
}
function plurality(votes) {
  const counts = PLAYERS.map(actor => [actor, votes.filter(v => v.target === actor).length]);
  const high = Math.max(...counts.map(([, n]) => n));
  const leaders = counts.filter(([, n]) => n === high);
  return leaders.length === 1 ? leaders[0][0] : null;
}
function validAction(action, phase, actor) {
  if (exactKeys(action, ['op']) && action.op === 'decline') return true;
  if (phase === 'vote') return exactKeys(action, ['op', 'target']) && action.op === phase &&
    PLAYERS.includes(action.target) && action.target !== actor;
  return exactKeys(action, ['op', 'text']) && action.op === phase && cleanText(action.text) &&
    !['pass', 'skip', 'decline', '패스', '기권'].includes(normalize(action.text));
}

// Reject a corrupt or foreign file, including plausible-looking but impossible claims.
// Validate the bounded transcript against turn order rather than maintaining another schema/history.
function validate(state) {
  const check = condition => { if (!condition) throw new Error('Invalid private LiarGame state'); };
  check(exactKeys(state, ['version', 'revision', 'nextStartAt', 'announcedFor', 'recentWordIds', 'round']));
  check(state.version === 1 && integer(state.revision) && integer(state.nextStartAt) && state.nextStartAt >= LEAD);
  check(state.announcedFor === null || state.announcedFor === state.nextStartAt);
  check(Array.isArray(state.recentWordIds) && state.recentWordIds.length <= 8 &&
    new Set(state.recentWordIds).size === state.recentWordIds.length &&
    state.recentWordIds.every(id => integer(id) && id < BANK.length));
  const r = state.round;
  if (r === null) { check(state.recentWordIds.length === 0); return; }
  check(exactKeys(r, ['id', 'scheduledAt', 'phase', 'status', 'players', 'liar', 'wordId', 'startedAt',
    'deadlineAt', 'readyAt', 'step', 'clues', 'votes', 'claim', 'result']));
  check(typeof r.id === 'string' && /^r-[a-z0-9]+-[a-z0-9]+-[a-f0-9]{32}$/.test(r.id));
  check(Array.isArray(r.players) && r.players.length === 4 && new Set(r.players).size === 4 && r.players.every(p => PLAYERS.includes(p)));
  check(PLAYERS.includes(r.liar) && integer(r.wordId) && r.wordId < BANK.length && state.recentWordIds.at(-1) === r.wordId);
  check(integer(r.scheduledAt) && r.scheduledAt >= LEAD && integer(r.startedAt) && r.startedAt >= r.scheduledAt &&
    r.startedAt < r.scheduledAt + GRACE && r.deadlineAt === r.startedAt + ROUND_TTL);
  check(integer(r.readyAt) && r.readyAt >= r.startedAt && r.readyAt <= r.deadlineAt + GAP);
  check(state.nextStartAt > r.scheduledAt && (state.nextStartAt - r.scheduledAt) % CADENCE === 0);
  check(integer(r.step) && r.step <= 13 && Array.isArray(r.clues) && r.clues.length === Math.min(r.step, 8));
  check(r.clues.every((c, i) => exactKeys(c, ['actor', 'phase', 'text']) && c.actor === r.players[i % 4] &&
    c.phase === (i < 4 ? 'clue' : 'discussion') && cleanText(c.text) && c.text === c.text.trim() && !leaks(c.text, r.wordId)));
  check(Array.isArray(r.votes) && r.votes.length === Math.min(Math.max(r.step - 8, 0), 4));
  check(r.votes.every((v, i) => exactKeys(v, ['actor', 'target']) && v.actor === r.players[i] &&
    PLAYERS.includes(v.target) && v.target !== v.actor));
  if (r.status === 'active') {
    check(r.result === null && r.phase === (r.step < 4 ? 'clue' : r.step < 8 ? 'discussion' : r.step < 12 ? 'vote' : 'guess'));
    check(r.step <= 12 && (r.step < 12 || plurality(r.votes) === r.liar));
  } else {
    check(r.status === 'finished' && r.phase === 'finished' && r.claim === null);
    const result = r.result;
    check(result !== null && typeof result === 'object');
    if (result.outcome === 'cancelled') {
      check(exactKeys(result, ['outcome', 'reason']) && [CANCEL, DECLINE].includes(result.reason) && r.step <= 12);
    } else {
      const guessed = r.step === 13;
      check(exactKeys(result, guessed ? ['outcome', 'guess'] : ['outcome']) && r.step >= 12);
      const accused = plurality(r.votes);
      if (guessed) {
        check(accused === r.liar && cleanText(result.guess) && result.guess === result.guess.trim());
        const correct = BANK[r.wordId].aliases.some(a => normalize(a) === normalize(result.guess));
        check(result.outcome === (correct ? 'liar' : 'citizens'));
      } else check(result.outcome === (accused === null ? 'draw' : accused !== r.liar ? 'liar' : null));
    }
  }
  if (r.claim !== null) {
    const c = r.claim;
    check(r.status === 'active' && exactKeys(c, ['token', 'actor', 'phase', 'revision', 'claimedAt', 'expiresAt']));
    check(c.actor === actorFor(r) && c.phase === r.phase && c.revision === state.revision);
    check(typeof c.token === 'string' && c.token.startsWith(`${r.id}:${c.revision}:`) &&
      /^[a-f0-9]{64}$/.test(c.token.slice(`${r.id}:${c.revision}:`.length)));
    check(integer(c.claimedAt) && c.claimedAt >= r.readyAt && c.claimedAt < r.deadlineAt &&
      c.expiresAt === Math.min(c.claimedAt + CLAIM_TTL, r.deadlineAt));
  }
}

function existingFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Invalid private game file');
    return readFileSync(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

let tempSequence = 0;

export class LiarGame {
  #state;
  #file;
  #disk;
  #random;
  #clock;
  #openedAt;
  #broken = false;

  constructor(home, { now = Date.now, randomInt = secureRandomInt } = {}) {
    this.#clock = typeof now === 'function' ? now : () => now;
    const time = timestamp(this.#clock());
    this.#openedAt = time;
    if (typeof randomInt !== 'function') throw new Error('Invalid game random source');
    this.#random = randomInt;
    const directory = join(resolve(home), 'data');
    this.#file = join(directory, 'liar-game.json');
    try {
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid private directory');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      this.#disk = existingFile(this.#file);
      if (this.#disk !== null) {
        this.#state = JSON.parse(this.#disk);
        validate(this.#state);
      } else {
        this.#state = { version: 1, revision: 0, nextStartAt: time + LEAD, announcedFor: null, recentWordIds: [], round: null };
        this.#persist(this.#state);
      }
    } catch { throw new Error('LiarGame private state unavailable; original file must be preserved'); }
  }

  #healthy() { if (this.#broken) throw new Error('LiarGame disabled after a persistence failure'); }
  #time(now) { this.#healthy(); return timestamp(now ?? this.#clock()); }
  #pick(max) {
    const result = this.#random(max);
    if (!integer(result) || result >= max) throw new Error('Invalid game random source');
    return result;
  }
  #nonce(bytes) { return Array.from({ length: bytes }, () => this.#pick(256).toString(16).padStart(2, '0')).join(''); }

  #persist(next) {
    let fd, temporary, ownedTemporary = false;
    try {
      validate(next);
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > MAX_BYTES || existingFile(this.#file) !== this.#disk) throw new Error('Private state changed');
      temporary = `${this.#file}.${process.pid}.${++tempSequence}.tmp`;
      fd = openSync(temporary, 'wx', 0o600);
      ownedTemporary = true;
      writeFileSync(fd, serialized, 'utf8');
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.#file); temporary = undefined;
      if (process.platform !== 'win32') {
        const directory = openSync(join(this.#file, '..'), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      this.#disk = serialized;
      this.#state = next;
    } catch {
      this.#broken = true;
      throw new Error('LiarGame disabled after a persistence failure');
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      if (temporary && ownedTemporary) { try { unlinkSync(temporary); } catch {} }
    }
  }
  #commit(next) { next.revision = this.#state.revision + 1; this.#persist(next); }
  #finish(round, outcome, extra = {}) {
    round.phase = 'finished'; round.status = 'finished'; round.claim = null;
    round.result = { outcome, ...extra };
  }
  #cancel(notice = CANCEL) {
    const next = structuredClone(this.#state);
    this.#finish(next.round, 'cancelled', { reason: notice });
    this.#commit(next);
    return { ok: false, changed: true, notices: [notice], finished: true };
  }
  #expired(round, now) {
    return now >= round.deadlineAt || (round.claim !== null && now >= round.claim.expiresAt);
  }
  #matching(token, actor) {
    const round = this.#state.round;
    return typeof token === 'string' && round?.status === 'active' && round.claim !== null &&
      round.claim.token === token && round.claim.actor === actor;
  }

  advance(now, { running, available, busy } = {}) {
    now = this.#time(now);
    const next = structuredClone(this.#state), notices = [];
    let changed = false, ended = false;
    if (next.round?.status === 'active' && (running !== true || available !== true || this.#expired(next.round, now))) {
      this.#finish(next.round, 'cancelled', { reason: CANCEL });
      notices.push(CANCEL); changed = true; ended = true;
    }
    if (next.round?.status !== 'active' && now >= next.nextStartAt) {
      const scheduledAt = next.nextStartAt;
      // An off room skips immediately; ongoing work and brief connection trouble share ten-minute grace.
      // A clock jump past grace skips every missed slot in one arithmetic operation.
      if (ended || scheduledAt < this.#openedAt || running !== true || now >= scheduledAt + GRACE) {
        next.nextStartAt += (Math.floor((now - scheduledAt) / CADENCE) + 1) * CADENCE;
        next.announcedFor = null; changed = true;
        if (!ended && running === true) notices.push(SKIP);
      } else if (available === true && busy === false) {
        const players = [...PLAYERS];
        for (let i = players.length - 1; i > 0; i--) { const j = this.#pick(i + 1); [players[i], players[j]] = [players[j], players[i]]; }
        const choices = BANK.filter(w => !next.recentWordIds.includes(w.id));
        const wordId = choices[this.#pick(choices.length)].id;
        next.round = {
          id: `r-${scheduledAt.toString(36)}-${(next.revision + 1).toString(36)}-${this.#nonce(16)}`,
          scheduledAt, phase: 'clue', status: 'active', players, liar: players[this.#pick(4)], wordId,
          startedAt: now, deadlineAt: now + ROUND_TTL, readyAt: now, step: 0,
          clues: [], votes: [], claim: null, result: null,
        };
        next.recentWordIds = [...next.recentWordIds, wordId].slice(-8);
        next.nextStartAt = scheduledAt + CADENCE; next.announcedFor = null;
        notices.push('라이어 게임을 시작합니다. 원하지 않으면 언제든 참여를 그만둘 수 있습니다.');
        changed = true;
      }
    }
    if (next.round?.status !== 'active' && running === true && available === true && now >= next.nextStartAt - LEAD &&
        now < next.nextStartAt && next.announcedFor !== next.nextStartAt) {
      next.announcedFor = next.nextStartAt;
      notices.push('곧 라이어 게임이 예정되어 있습니다. 시작 전까지 평소처럼 이야기해 주세요.');
      changed = true;
    }
    if (changed) this.#commit(next);
    return { changed, notices };
  }

  // Maintenance-only, compare-and-set repair for a never-played calendar.
  // No HTTP route exposes this; active or completed games are never rescheduled.
  rescheduleUnplayed(now, expected) {
    now = this.#time(now);
    const s = this.#state;
    if (!exactKeys(expected, ['revision', 'nextStartAt']) || s.round !== null || s.recentWordIds.length
      || s.revision !== expected.revision || s.nextStartAt !== expected.nextStartAt
      || s.nextStartAt <= now + LEAD) return { ok: false };
    const next = structuredClone(s);
    next.nextStartAt = now + LEAD; next.announcedFor = null;
    this.#commit(next);
    return { ok: true, nextStartAt: next.nextStartAt };
  }

  view(now) {
    now = this.#time(now);
    const s = this.#state, r = s.round;
    let round = null;
    if (r !== null) {
      let result = null;
      if (r.status === 'finished') {
        const cancelled = r.result.outcome === 'cancelled';
        result = { outcome: r.result.outcome, liar: cancelled ? null : r.liar,
          word: cancelled ? null : BANK[r.wordId].word, votes: cancelled ? [] : r.votes.map(v => ({ actor: v.actor, target: v.target })) };
        if (r.result.guess !== undefined) result.guess = r.result.guess;
        if (r.result.reason !== undefined) result.reason = r.result.reason;
      }
      round = { id: r.id, phase: r.phase, status: r.status, category: BANK[r.wordId].category,
        players: [...r.players], turn: r.phase === 'guess' ? null : actorFor(r), step: r.step, totalSteps: 13,
        startedAt: r.startedAt, deadlineAt: r.deadlineAt,
        clues: r.clues.map(c => ({ actor: c.actor, phase: c.phase, text: c.text })),
        submitted: r.phase === 'vote' ? r.votes.map(v => v.actor) :
          r.phase === 'clue' || r.phase === 'discussion' ? r.clues.filter(c => c.phase === r.phase).map(c => c.actor) : [], result };
    }
    return { version: 1, revision: s.revision, serverNow: now, nextStartAt: s.nextStartAt, noticeAt: s.nextStartAt - LEAD, round };
  }

  pending(now) {
    now = this.#time(now);
    const r = this.#state.round;
    if (!r || r.status !== 'active' || r.claim !== null || now < r.readyAt || now >= r.deadlineAt) return null;
    return { roundId: r.id, revision: this.#state.revision, actor: actorFor(r), phase: r.phase };
  }

  claim(ticket, now) {
    now = this.#time(now);
    const expected = this.pending(now);
    if (!expected || !exactKeys(ticket, ['roundId', 'revision', 'actor', 'phase']) ||
        Object.keys(expected).some(key => ticket[key] !== expected[key])) return { ok: false };
    const next = structuredClone(this.#state), revision = next.revision + 1;
    const token = `${next.round.id}:${revision}:${this.#nonce(32)}`;
    next.round.claim = { token, actor: expected.actor, phase: expected.phase, revision,
      claimedAt: now, expiresAt: Math.min(now + CLAIM_TTL, next.round.deadlineAt) };
    this.#commit(next);
    return { ok: true, token };
  }

  context(actor, token) {
    this.#healthy();
    if (!this.#matching(token, actor)) return null;
    const r = this.#state.round, role = actor === r.liar ? 'liar' : 'citizen';
    const context = { roundId: r.id, phase: r.phase, actor, category: BANK[r.wordId].category,
      players: [...r.players], role, clues: r.clues.map(c => ({ actor: c.actor, phase: c.phase, text: c.text })),
      choices: r.phase === 'vote' ? r.players.filter(p => p !== actor) : [],
      instruction: '가벼운 말놀이입니다. 현재 단계의 JSON 행동 하나만 답하세요. 단서와 토론은 240자 이내이며 정답 단어·별칭을 그대로 쓰거나 띄어쓰기·문장부호로 나누어 쓰지 마세요. 다른 사람의 역할을 아는 척하지 마세요. 투표는 choices 중 자신을 제외한 한 명입니다. 추측은 단어 하나입니다. 참여를 원하지 않거나 계속할 수 없으면 {"op":"decline"}으로 끝내도 됩니다. 실제로 만들기·먹기·이동하기 등 어떤 행동도 요구하지 않습니다. clue/discussion/guess: {"op":"현재 단계","text":"내용"}; vote: {"op":"vote","target":"공개 ID"}.' };
    if (role === 'citizen') context.word = BANK[r.wordId].word;
    return context;
  }

  // No mutation, payload echo, or secret-dependent explanation leaves this check.
  assess(token, actor, action, now) {
    now = this.#time(now);
    if (!this.#matching(token, actor)) return { ok: false, reason: 'stale', phase: null };
    const r = this.#state.round;
    const result = reason => ({ ok: reason === 'valid' || reason === 'decline', reason, phase: r.phase });
    if (now < r.claim.claimedAt) return result('stale');
    if (this.#expired(r, now)) return result('expired');
    if (!validAction(action, r.phase, actor)) return result('invalid_action');
    if (action.op === 'decline') return result('decline');
    if ((r.phase === 'clue' || r.phase === 'discussion') && leaks(action.text, r.wordId)) return result('answer_leak');
    return result('valid');
  }

  submit(token, actor, action, now) {
    now = this.#time(now);
    const assessment = this.assess(token, actor, action, now);
    if (assessment.reason === 'stale') return { ok: false, changed: false, notices: [] };
    if (!assessment.ok) return this.#cancel();
    const r = this.#state.round;
    if (action.op === 'decline') return { ...this.#cancel(DECLINE), ok: true };
    const next = structuredClone(this.#state), round = next.round;
    let speech;
    round.claim = null; round.step++; round.readyAt = now + GAP;
    if (action.op === 'clue' || action.op === 'discussion') {
      const text = action.text.trim();
      round.clues.push({ actor, phase: action.op, text }); speech = { actor, text };
      round.phase = round.step < 4 ? 'clue' : round.step < 8 ? 'discussion' : 'vote';
    } else if (action.op === 'vote') {
      round.votes.push({ actor, target: action.target });
      if (round.step === 12) {
        const accused = plurality(round.votes);
        if (accused === round.liar) round.phase = 'guess';
        else this.#finish(round, accused === null ? 'draw' : 'liar');
      }
    } else {
      const guess = action.text.trim();
      const correct = BANK[round.wordId].aliases.some(alias => normalize(alias) === normalize(guess));
      this.#finish(round, correct ? 'liar' : 'citizens', { guess });
    }
    this.#commit(next);
    const finished = round.status === 'finished';
    return { ok: true, changed: true, notices: finished ? [DONE] : [], ...(speech ? { speech } : {}), finished };
  }

  fail(token, actor, now) {
    now = this.#time(now);
    if (!this.#matching(token, actor) || now < this.#state.round.claim.claimedAt) return { ok: false, changed: false, notices: [] };
    return this.#cancel();
  }
}
