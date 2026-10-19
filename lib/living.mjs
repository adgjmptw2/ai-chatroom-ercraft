// One synchronous writer per room. No providers, background work, or world effects.
// view()/event/result text contains internal IDs; the parent owns public projection.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LIVING_RECIPES = Object.freeze(Object.fromEntries([
  ['soup', '수프', 90000], ['burger', '버거', 75000],
  ['tea', '차', 45000], ['toast', '토스트', 60000],
  ['dumplings', '만두', 75000], ['cookies', '쿠키', 15000], ['fruit', '과일', 15000],
].map(([id, label, durationMs]) => [id, Object.freeze({ label, durationMs, servings: 4 })])));

export const LIVING_SPOTS = Object.freeze(['sofa-1','sofa-2','sofa-3','sofa-4','adina-bed','bianca-bed','eleven-bed','lucia-bed']);
export const BLANKET_STYLES = Object.freeze(['mint','butter','pink','lavender']);
const emptyProps = () => ({ revision: 0, tableSet: false, blankets: [] });
const spotName = spot => spot.startsWith('sofa-') ? `거실 소파 ${spot.slice(-1)}번 자리`
  : ({'adina-bed':'아디나 침대','bianca-bed':'비앙카 침대','eleven-bed':'일레븐 침대','lucia-bed':'루치아 침대'})[spot];
const MAX_BYTES = 64 * 1024;
const WAIT_MS = 5 * 60 * 1000, PLAY_MS = 3 * 60 * 1000;
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const FIELDS = {
  table_set: ['op', 'revision'], table_clear: ['op', 'revision'],
  blanket_spread: ['op', 'spot', 'style', 'revision'], blanket_fold: ['op', 'spot', 'revision'],
  relax: ['op', 'spot'],
  cook: ['op', 'recipe'], serve: ['op', 'mealId', 'revision'], eat: ['op', 'mealId', 'revision'],
  meal_clear: ['op', 'mealId', 'revision'],
  game_create: ['op'], game_join: ['op', 'gameId', 'revision'],
  game_move: ['op', 'gameId', 'revision', 'cell'], game_leave: ['op', 'gameId', 'revision'],
};
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const identifier = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128
  && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v);
const record = (v) => v !== null && typeof v === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const shape = (v, keys) => record(v) && Reflect.ownKeys(v).length === keys.length
  && keys.every((k) => Object.hasOwn(v, k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value'));
const win = (board, mark) => LINES.find((line) => line.every((cell) => board[cell] === mark));
const fresh = (at) => ({ version: 1, revision: 0, pausedAt: at, meal: null, game: null, events: [] });
const activeMeal = (meal) => meal !== null && meal.status !== 'finished';
const activeGame = (game) => game !== null && game.status !== 'finished';

export class LivingError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LivingError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new LivingError(code, message); };
const ensure = (ok, message = '저장된 생활 상태가 올바르지 않습니다.') => {
  if (!ok) fail('invalid_living_state', message);
};
function time(at) {
  if (!integer(at)) fail('invalid_time', '생활 시간은 0 이상의 안전한 정수여야 합니다.');
  return at;
}
const later = (at, delay) => time(at + delay);

function roster(members) {
  const ids = Array.isArray(members) ? members : members instanceof Set ? [...members]
    : record(members) ? Object.keys(members) : null;
  if (!ids || !ids.every(identifier) || new Set(ids).size !== ids.length) {
    fail('invalid_members', '멤버 목록에는 중복 없는 멤버 ID를 넣어 주세요.');
  }
  return new Set(ids);
}

function validateState(s, members) {
  ensure(shape(s, ['version', 'revision', 'pausedAt', 'meal', 'game', 'events', ...(Object.hasOwn(s, 'props') ? ['props'] : [])]) && s.version === 1
    && integer(s.revision) && (s.pausedAt === null || integer(s.pausedAt)));
  const scope = (v) => identifier(v.id) && integer(v.revision) && v.revision >= 1 && v.revision <= s.revision;
  const known = (v) => identifier(v) && members.has(v);
  if (Object.hasOwn(s, 'props')) {
    const p = s.props;
    ensure(shape(p, ['revision','tableSet','blankets']) && integer(p.revision) && p.revision <= s.revision
      && typeof p.tableSet === 'boolean' && Array.isArray(p.blankets) && p.blankets.length <= 4);
    const spots = new Set();
    for (const b of p.blankets) {
      ensure(shape(b, ['spot','style','owner']) && LIVING_SPOTS.includes(b.spot)
        && BLANKET_STYLES.includes(b.style) && known(b.owner) && !spots.has(b.spot));
      spots.add(b.spot);
    }
    ensure(p.revision > 0 || !p.tableSet && p.blankets.length === 0);
  }
  const m = s.meal;
  if (m !== null) {
    ensure(shape(m, ['id', 'revision', 'recipe', 'label', 'status', 'cook', 'readyAt', 'servings', 'remaining', 'eatenBy'])
      && scope(m) && Object.hasOwn(LIVING_RECIPES, m.recipe));
    ensure(m.label === LIVING_RECIPES[m.recipe].label && known(m.cook) && integer(m.readyAt)
      && m.servings === 4 && integer(m.remaining) && m.remaining <= 4 && Array.isArray(m.eatenBy)
      && m.eatenBy.length === 4 - m.remaining && m.eatenBy.every(known)
      && new Set(m.eatenBy).size === m.eatenBy.length);
    ensure(['cooking', 'ready', 'served', 'finished'].includes(m.status)
      && (!['cooking', 'ready'].includes(m.status) || m.remaining === 4)
      && (m.status !== 'served' || m.remaining > 0) && (m.status !== 'finished' || m.remaining === 0));
    const minimum = { cooking: 1, ready: 2, served: 3, finished: 3 }[m.status] + m.eatenBy.length;
    ensure(m.revision >= minimum);
  }
  const g = s.game;
  if (g !== null) {
    ensure(shape(g, ['id', 'revision', 'kind', 'status', 'players', 'board', 'turn', 'winner', 'result', 'winningCells', 'expiresAt'])
      && scope(g) && g.kind === 'tic-tac-toe' && ['waiting', 'playing', 'finished'].includes(g.status)
      && Array.isArray(g.players) && [1, 2].includes(g.players.length) && g.players.every(known)
      && new Set(g.players).size === g.players.length && Array.isArray(g.board) && g.board.length === 9
      && g.board.every((v) => v === null || v === 'X' || v === 'O') && Array.isArray(g.winningCells));
    const x = g.board.filter((v) => v === 'X').length, o = g.board.filter((v) => v === 'O').length;
    const xWin = win(g.board, 'X'), oWin = win(g.board, 'O');
    ensure(x === o || x === o + 1);
    ensure(g.players.length === 2 || x + o === 0);
    if (g.status === 'finished') {
      ensure(g.turn === null && g.expiresAt === null && ['win', 'draw', 'abandoned', 'expired'].includes(g.result));
      if (g.result === 'win') {
        ensure(g.players.length === 2 && !!xWin !== !!oWin);
        const mark = xWin ? 'X' : 'O', cells = xWin || oWin;
        ensure((mark === 'X' ? x === o + 1 : x === o) && g.winner === g.players[mark === 'X' ? 0 : 1]
          && JSON.stringify(g.winningCells) === JSON.stringify(cells));
        // A winning board must have a possible last move, with no earlier victory.
        ensure(g.board.some((v, i) => {
          if (v !== mark) return false;
          const before = [...g.board]; before[i] = null;
          return !win(before, 'X') && !win(before, 'O');
        }));
      } else {
        ensure(!xWin && !oWin && g.winner === null && g.winningCells.length === 0);
        ensure(g.result === 'draw' ? x + o === 9 && g.players.length === 2 : x + o < 9);
      }
    } else {
      ensure(integer(g.expiresAt) && g.result === null && g.winner === null && g.winningCells.length === 0
        && !xWin && !oWin && x + o < 9);
      ensure(g.status === 'waiting' ? g.players.length === 1 && x + o === 0 && g.turn === null
        : g.players.length === 2 && g.turn === g.players[x === o ? 0 : 1]);
    }
    const terminalExtra = ['abandoned', 'expired'].includes(g.result) ? 1 : 0;
    ensure(g.revision >= g.players.length + x + o + terminalExtra);
  }
  ensure(Array.isArray(s.events) && s.events.length === Math.min(s.revision, 8));
  const eventIds = new Set();
  for (const event of s.events) {
    ensure(shape(event, ['id', 'at', 'text']) && identifier(event.id) && !eventIds.has(event.id)
      && integer(event.at) && typeof event.text === 'string' && event.text.length > 0 && event.text.length <= 2048);
    eventIds.add(event.id);
  }
  ensure(s.revision !== 0 || s.meal === null && s.game === null && s.pausedAt !== null);
}

function readState(file, members) {
  try {
    const stat = fs.lstatSync(file);
    ensure(stat.isFile() && stat.size <= MAX_BYTES);
    const bytes = fs.readFileSync(file);
    ensure(bytes.length <= MAX_BYTES);
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    validateState(state, members);
    return state;
  } catch (error) {
    // Only a missing file creates a new room; damaged/unreadable state is retained.
    if (error.code === 'ENOENT') return null;
    if (error instanceof LivingError) throw error;
    throw new LivingError('invalid_living_state', '생활 상태를 읽지 못했습니다. 저장 파일을 확인해 주세요.', error);
  }
}

function atomicWrite(file, state) {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) fail('living_state_too_large', '생활 상태의 저장 한도를 넘었습니다.');
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd, owned = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(temp, 'wx'); owned = true;
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    owned = false;
  } catch (error) {
    throw new LivingError('living_persist_failed', '생활 상태를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', error);
  } finally {
    // Cleanup cannot turn a successful rename into a reported failed transaction.
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (owned) { try { fs.unlinkSync(temp); } catch {} }
  }
}

/**
 * members: an array/Set of IDs or an object keyed by ID (default: no actors).
 * New rooms immediately persist their paused state. All writes are synchronous,
 * atomic and bounded to 64 KiB. Temporary writes stay beside data/living.json.
 * Use one instance/writer for a root. Scoped revisions arbitrate concurrent callers.
 * advance() is the only timer driver; restart never invents elapsed active time.
 * pause()/resume()/advance()/flush() throw LivingError on I/O failure; act()/validate()
 * return {ok:false, changed:false, text, error:code}. All public projection is external.
 */
export class LivingRoom {
  #state;
  #members;
  #now;
  #file;
  #saved;

  constructor(root, { members = [], now = Date.now } = {}) {
    if (typeof root !== 'string' || !root || typeof now !== 'function') {
      fail('invalid_living_options', '생활 공간의 경로와 시계를 확인해 주세요.');
    }
    this.#members = roster(members);
    this.#now = now;
    this.#file = path.join(root, 'data', 'living.json');
    const loaded = readState(this.#file, this.#members);
    this.#state = loaded ?? fresh(time(now()));
    this.#saved = loaded !== null;
    this.flush();
  }

  view() { return structuredClone(this.#state); }

  flush() {
    if (!this.#saved) {
      atomicWrite(this.#file, this.#state);
      this.#saved = true;
    }
  }

  #commit(next, text, at) {
    next.revision = later(this.#state.revision, 1);
    next.events.push({ id: randomUUID(), at, text });
    next.events = next.events.slice(-8);
    validateState(next, this.#members);
    atomicWrite(this.#file, next);
    this.#state = next;
    this.#saved = true;
  }

  #scoped(value, id, revision, noun) {
    if (!identifier(id) || !integer(revision) || revision < 1) {
      fail('invalid_command', `${noun} ID와 현재 revision을 넣어 주세요.`);
    }
    if (!value || value.id !== id || value.revision !== revision) {
      fail('stale_revision', `${noun} 상태가 바뀌었습니다. 현재 ID와 revision을 다시 확인해 주세요.`);
    }
    return value;
  }

  #prepare(actor, command, at) {
    if (!identifier(actor) || !this.#members.has(actor)) fail('unknown_member', '방 멤버만 생활 행동을 할 수 있습니다.');
    if (!record(command) || !Object.hasOwn(command, 'op')
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(command, 'op'), 'value')
      || typeof command.op !== 'string' || !Object.hasOwn(FIELDS, command.op)
      || !shape(command, FIELDS[command.op])) fail('invalid_command', '생활 명령과 필요한 필드를 확인해 주세요.');
    if (this.#state.pausedAt !== null) fail('living_paused', '생활 기능이 일시정지 중입니다. 재개 후 시도해 주세요.');
    const next = this.view(), op = command.op;
    let text;
    if (['table_set','table_clear','blanket_spread','blanket_fold'].includes(op)) {
      const props = next.props ?? emptyProps();
      if (!integer(command.revision) || command.revision !== props.revision) {
        fail('stale_revision', '생활 소품 상태가 바뀌었습니다. 현재 소품 revision을 확인해 주세요.');
      }
      if (op === 'table_set') {
        if (props.tableSet || ['served','finished'].includes(next.meal?.status)) fail('already_set', '이미 식탁이 차려져 있습니다.');
        props.tableSet = true;
        text = `${actor}: 식탁에 네 사람의 접시와 컵을 차렸습니다.`;
      } else if (op === 'table_clear') {
        if (next.meal?.status === 'served') fail('food_on_table', '음식이 남아 있습니다. 식사를 마치거나 남은 음식을 먼저 정리해 주세요.');
        if (!props.tableSet && next.meal?.status !== 'finished') fail('already_clear', '정리할 식기가 없습니다.');
        props.tableSet = false;
        if (next.meal?.status === 'finished') next.meal = null;
        text = `${actor}: 식탁의 빈 접시와 컵을 정리했습니다.`;
      } else {
        if (!LIVING_SPOTS.includes(command.spot)) fail('invalid_spot', '실제 소파나 침대 자리를 골라 주세요.');
        const index = props.blankets.findIndex(b => b.spot === command.spot);
        if (op === 'blanket_spread') {
          if (!BLANKET_STYLES.includes(command.style)) fail('invalid_style', '담요 색은 mint/butter/pink/lavender 중에서 골라 주세요.');
          if (index >= 0) fail('already_spread', '이미 담요이 놓인 자리입니다.');
          if (props.blankets.length >= 4) fail('blanket_limit', '네 장의 담요이 모두 나와 있습니다. 먼저 한 장을 정리해 주세요.');
          props.blankets.push({spot:command.spot, style:command.style, owner:actor});
          text = `${actor}: ${spotName(command.spot)}에 담요을 펴고 자리를 잡았습니다.`;
        } else {
          if (index < 0) fail('blanket_missing', '그 자리에 정리할 담요이 없습니다.');
          if (props.blankets[index].owner !== actor) fail('not_blanket_owner', '담요을 편 멤버가 직접 정리할 수 있습니다.');
          props.blankets.splice(index, 1);
          text = `${actor}: ${spotName(command.spot)}의 담요을 접었습니다.`;
        }
      }
      props.revision++;
      next.props = props;
    } else if (op === 'relax') {
      if (!LIVING_SPOTS.includes(command.spot)) fail('invalid_spot', '실제 소파나 침대 자리를 골라 주세요.');
      text = `${actor}: ${spotName(command.spot)}에서 ${command.spot.startsWith('sofa-') ? '앉아 쉬고 있습니다.' : '누워 쉬고 있습니다.'}`;
    } else if (op === 'cook') {
      if (typeof command.recipe !== 'string' || !Object.hasOwn(LIVING_RECIPES, command.recipe)) {
        fail('invalid_recipe', '메뉴는 soup/burger/tea/toast/dumplings/cookies/fruit 중에서 골라 주세요.');
      }
      if (activeMeal(next.meal)) fail('meal_active', '진행 중인 식사를 먼저 마치거나 정리해 주세요.');
      const recipe = LIVING_RECIPES[command.recipe];
      next.meal = { id: randomUUID(), revision: 1, recipe: command.recipe, label: recipe.label,
        status: 'cooking', cook: actor, readyAt: later(at, recipe.durationMs),
        servings: 4, remaining: 4, eatenBy: [] };
      text = `${actor}: ${recipe.label} 4인분 요리를 시작했습니다. (${recipe.durationMs / 1000}초)`;
    } else if (op === 'serve' || op === 'eat' || op === 'meal_clear') {
      const m = this.#scoped(next.meal, command.mealId, command.revision, '식사');
      if (op === 'meal_clear') {
        if (m.status === 'finished') fail('meal_empty', '정리할 음식이 없습니다.');
        if (m.status === 'cooking' && m.cook !== actor) fail('not_cook', '조리 중에는 요리를 시작한 멤버만 취소할 수 있습니다.');
        next.meal = null;
        text = m.status === 'cooking' ? `${actor}: ${m.label} 조리를 취소했습니다.`
          : `${actor}: 남은 ${m.label} ${m.remaining}인분을 정리했습니다.`;
      } else if (op === 'serve') {
        if (m.status !== 'ready') fail('meal_not_ready', '요리가 준비된 뒤에 차릴 수 있습니다.');
        m.status = 'served';
        text = `${actor}: ${m.label} 4인분을 식탁에 차렸습니다.`;
      } else {
        if (m.eatenBy.includes(actor)) fail('already_eaten', '이번 식사는 한 사람당 한 번만 먹을 수 있습니다.');
        if (m.status !== 'served') fail('meal_not_served', '식탁에 차려진 음식을 먹을 수 있습니다.');
        m.eatenBy.push(actor); m.remaining--;
        if (m.remaining === 0) m.status = 'finished';
        text = `${actor}: ${m.label} 1인분을 먹었습니다. ${m.remaining ? `${m.remaining}인분 남았습니다.` : '식사를 마쳤습니다.'}`;
      }
      m.revision++;
    } else if (op === 'game_create') {
      if (activeGame(next.game)) fail('game_active', '진행 중인 삼목을 먼저 마쳐 주세요.');
      next.game = { id: randomUUID(), revision: 1, kind: 'tic-tac-toe', status: 'waiting',
        players: [actor], board: Array(9).fill(null), turn: null, winner: null, result: null,
        winningCells: [], expiresAt: later(at, WAIT_MS) };
      text = `${actor}: 삼목 참가자를 기다리고 있습니다. 누구나 관전할 수 있습니다.`;
    } else {
      const g = this.#scoped(next.game, command.gameId, command.revision, '게임');
      if (g.status === 'finished') fail('game_finished', '이미 끝난 게임입니다. 새 게임을 만들어 주세요.');
      if (at >= g.expiresAt) fail('game_expired', '게임 시간이 지났습니다. 만료 처리 후 새 게임을 만들어 주세요.');
      if (op === 'game_join') {
        if (g.status !== 'waiting') fail('game_full', '이미 두 사람이 게임 중입니다. 관전할 수 있습니다.');
        if (g.players.includes(actor)) fail('already_joined', '이미 참가 중입니다. 다른 참가자를 기다려 주세요.');
        g.players.push(actor); g.status = 'playing'; g.turn = g.players[0];
        g.expiresAt = later(at, PLAY_MS);
        text = `${actor}: 삼목에 참가했습니다. ${g.turn} 차례입니다.`;
      } else if (op === 'game_leave') {
        if (!g.players.includes(actor)) fail('not_player', '참가자만 게임을 끝낼 수 있습니다.');
        g.status = 'finished'; g.turn = null; g.result = 'abandoned'; g.expiresAt = null;
        text = `${actor}: 삼목에서 나갔습니다. 게임을 종료했습니다.`;
      } else {
        if (g.status !== 'playing') fail('game_waiting', '두 번째 참가자가 들어온 뒤 시작할 수 있습니다.');
        if (!g.players.includes(actor)) fail('not_player', '관전 중에는 돌을 놓을 수 없습니다.');
        if (g.turn !== actor) fail('not_your_turn', '지금은 다른 참가자의 차례입니다.');
        if (!Number.isInteger(command.cell) || command.cell < 0 || command.cell > 8) {
          fail('invalid_cell', 'cell은 0부터 8까지의 정수여야 합니다.');
        }
        if (g.board[command.cell] !== null) fail('occupied_cell', '이미 돌이 있는 칸입니다. 빈 칸을 골라 주세요.');
        const mark = actor === g.players[0] ? 'X' : 'O';
        g.board[command.cell] = mark;
        const cells = win(g.board, mark);
        text = `${actor}: ${command.cell}번 칸에 ${mark}를 놓았습니다.`;
        if (cells || g.board.every((v) => v !== null)) {
          g.status = 'finished'; g.turn = null; g.expiresAt = null;
          g.result = cells ? 'win' : 'draw'; g.winner = cells ? actor : null;
          g.winningCells = cells ? [...cells] : [];
          text += cells ? ` ${actor} 승리입니다!` : ' 무승부입니다.';
        } else {
          g.turn = g.players[actor === g.players[0] ? 1 : 0];
          g.expiresAt = later(at, PLAY_MS);
        }
      }
      g.revision++;
    }
    return { next, text };
  }

  // Validation is advisory: the eventual act() checks IDs/revisions again. A failed
  // action never runs advance(), even if a deadline passed while furniture was reserved.
  act(actor, command, at = this.#now(), { dryRun = false } = {}) {
    try {
      time(at);
      if (typeof dryRun !== 'boolean') fail('invalid_command', 'dryRun은 참 또는 거짓이어야 합니다.');
      const { next, text } = this.#prepare(actor, command, at);
      if (!dryRun) this.#commit(next, text, at);
      return { ok: true, changed: !dryRun, text: dryRun ? '실행 가능한 생활 행동입니다.' : text };
    } catch (error) {
      if (!(error instanceof LivingError)) throw error;
      return { ok: false, changed: false, text: error.message, error: error.code };
    }
  }

  validate(actor, command, at = this.#now()) { return this.act(actor, command, at, { dryRun: true }); }

  pause(at = this.#now()) {
    time(at);
    if (this.#state.pausedAt !== null) return { changed: false };
    const next = this.view(); next.pausedAt = at;
    if (activeMeal(next.meal)) next.meal.revision++;
    if (activeGame(next.game)) next.game.revision++;
    const text = '생활 기능을 일시정지했습니다.';
    this.#commit(next, text, at);
    return { changed: true, text };
  }

  resume(at = this.#now()) {
    time(at);
    if (this.#state.pausedAt === null) return { changed: false };
    if (at < this.#state.pausedAt) fail('invalid_time', '재개 시간은 일시정지 시간보다 빠를 수 없습니다.');
    const next = this.view(), elapsed = at - next.pausedAt;
    next.pausedAt = null;
    if (activeMeal(next.meal)) {
      next.meal.revision++;
      if (next.meal.status === 'cooking') next.meal.readyAt = later(next.meal.readyAt, elapsed);
    }
    if (activeGame(next.game)) {
      next.game.revision++; next.game.expiresAt = later(next.game.expiresAt, elapsed);
    }
    const text = '생활 기능을 재개했습니다.';
    this.#commit(next, text, at);
    return { changed: true, text };
  }

  advance(at = this.#now()) {
    time(at);
    if (this.#state.pausedAt !== null) return { changed: false };
    const next = this.view(), texts = [];
    if (next.meal?.status === 'cooking' && at >= next.meal.readyAt) {
      next.meal.status = 'ready'; next.meal.revision++;
      texts.push(`${next.meal.label} 4인분이 준비됐습니다. 식탁에 차릴 수 있습니다.`);
    }
    if (activeGame(next.game) && at >= next.game.expiresAt) {
      next.game.status = 'finished'; next.game.result = 'expired';
      next.game.turn = null; next.game.expiresAt = null; next.game.revision++;
      texts.push('삼목 활동 시간이 지나 게임을 종료했습니다.');
    }
    if (!texts.length) return { changed: false };
    const text = texts.join(' ');
    this.#commit(next, text, at);
    return { changed: true, text };
  }

  summary(nameOf = (id) => id) {
    const s = this.#state, at = s.pausedAt ?? time(this.#now());
    const name = (id) => String(nameOf(id) ?? '멤버').replace(/\s+/gu, ' ').slice(0, 80);
    const seconds = (until) => Math.max(0, Math.ceil((until - at) / 1000));
    const example = (cmd) => `예 ${JSON.stringify(cmd)}`;
    const out = [s.pausedAt === null ? '현재 생활 상태(참고 정보이며 할 일 목록이 아님): 실행 중.' : '현재 생활 상태(참고 정보이며 할 일 목록이 아님): 일시정지 중.'];
    const m = s.meal;
    if (!activeMeal(m)) {
      out.push(`주방: ${m ? '식사 완료.' : '진행 중인 식사 없음.'}`);
    } else {
      const info = `${m.label}(${name(m.cook)} 요리, ${m.remaining}/4인분)`;
      if (m.status === 'cooking') out.push(`주방: ${info}, 준비까지 ${seconds(m.readyAt)}초.`);
      else if (m.status === 'ready') out.push(`주방: ${info}, 차리기 가능. ${example({ op: 'serve', mealId: m.id, revision: m.revision })}`);
      else out.push(`식탁: ${info}, 1인 1회. 먹은 사람: ${m.eatenBy.map(name).join(', ') || '없음'}. ${example({ op: 'eat', mealId: m.id, revision: m.revision })}`);
      out.push(`${m.status === 'cooking' ? `${name(m.cook)}만 조리 취소` : '남은 음식 정리'}: ${example({ op: 'meal_clear', mealId: m.id, revision: m.revision })}`);
    }
    const props = s.props ?? emptyProps();
    out.push(`생활 소품 revision=${props.revision}. 식탁: ${props.tableSet || ['served','finished'].includes(m?.status) ? '식기 있음' : '식기 없음'}. 담요: ${props.blankets.map(b => `${b.spot}(${b.style}, ${name(b.owner)})`).join(', ') || '없음'}.`);
    const g = s.game;
    if (!g) out.push('삼목: 진행 중인 게임 없음.');
    else {
      const players = g.players.map((id, i) => `${i === 0 ? 'X' : 'O'}=${name(id)}`).join(', ');
      const scoped = { gameId: g.id, revision: g.revision };
      if (activeGame(g) && s.pausedAt === null && at >= g.expiresAt) {
        out.push(`삼목: ${players}, 시간 만료 처리 대기. 합법 수: 없음.`);
      } else if (g.status === 'waiting') {
        out.push(`삼목: ${players}, 참가 대기(${seconds(g.expiresAt)}초). 합법 수: 없음. ${example({ op: 'game_join', ...scoped })}`);
      } else if (g.status === 'playing') {
        const legal = g.board.flatMap((v, i) => v === null ? [i] : []);
        out.push(`삼목: ${players}, ${name(g.turn)} 차례(${seconds(g.expiresAt)}초). 합법 수(cell): ${s.pausedAt === null ? legal.join(',') : '없음(일시정지)'}. ${example({ op: 'game_move', ...scoped, cell: legal[0] })} cell은 예시값입니다. 현재 판을 보고 승리와 방어를 고려해 합법 수 중 직접 선택해 주세요.`);
      } else {
        const result = g.result === 'win' ? `${name(g.winner)} 승리` : { draw: '무승부', abandoned: '참가자 퇴장', expired: '시간 만료' }[g.result];
        out.push(`삼목: ${players}, 종료(${result}). 합법 수: 없음.`);
      }
      if (activeGame(g) && at < g.expiresAt) out.push(`참가자 종료: ${example({ op: 'game_leave', ...scoped })}`);
    }
    if (g && activeGame(g)) {
      out.push(`판 좌표(왼쪽 위부터 행 순서): ${[0, 3, 6].map((start) => g.board.slice(start, start + 3).map((v, i) => `${start + i}:${v ?? '·'}`).join(' ')).join(' / ')}.`);
    }
    return out.join('\n');
  }
}
