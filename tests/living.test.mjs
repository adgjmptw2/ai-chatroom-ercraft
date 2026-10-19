import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LivingRoom, LivingError, LIVING_RECIPES } from '../lib/living.mjs';

const MEMBERS = ['member-a', 'member-b', 'member-c', 'member-d', 'member-e'];
const NAMES = Object.fromEntries(MEMBERS.map((id, i) => [id, ['가람', '나래', '다온', '라온', '마루'][i]]));

function fixture(t, { paused = false, members = MEMBERS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chatroom-living-test-'));
  let at = 1000;
  const options = { members, now: () => at };
  const room = new LivingRoom(root, options);
  const file = path.join(root, 'data', 'living.json');
  if (!paused) room.resume();
  t.after(() => {
    // Delete only this fixture's resolved, freshly allocated temporary directory.
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('ai-chatroom-living-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { root, room, file, now: () => at, setTime: (value) => { at = value; },
    restart: () => new LivingRoom(root, options) };
}

const bytes = (f) => fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : null;
function unchanged(f, action, error) {
  const before = f.room.view(), saved = bytes(f);
  const result = action();
  assert.equal(result.changed, false);
  if (error) { assert.equal(result.ok, false); assert.equal(result.error, error); }
  assert.deepEqual(f.room.view(), before);
  assert.equal(bytes(f), saved);
  return result;
}
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.changed, true); return result; }
const act = (f, actor, command) => f.room.act(actor, command, f.now());
function mealCommand(f, op) {
  const m = f.room.view().meal;
  return { op, mealId: m.id, revision: m.revision };
}
function gameCommand(f, op, extra = {}) {
  const g = f.room.view().game;
  return { op, gameId: g.id, revision: g.revision, ...extra };
}
function startGame(f) {
  ok(act(f, MEMBERS[0], { op: 'game_create' }));
  ok(act(f, MEMBERS[1], gameCommand(f, 'game_join')));
}
function move(f, cell) { return act(f, f.room.view().game.turn, gameCommand(f, 'game_move', { cell })); }
function serve(f, recipe = 'tea') {
  ok(act(f, MEMBERS[0], { op: 'cook', recipe }));
  f.setTime(f.room.view().meal.readyAt);
  assert.equal(f.room.advance().changed, true);
  ok(act(f, MEMBERS[1], mealCommand(f, 'serve')));
}

test('new state starts paused, flush and restart preserve it, and no operating files are touched', (t) => {
  const f = fixture(t, { paused: true });
  assert.deepEqual(f.room.view(), { version: 1, revision: 0, pausedAt: 1000, meal: null, game: null, events: [] });
  assert.deepEqual(JSON.parse(bytes(f)), f.room.view());
  assert.deepEqual(f.restart().view(), f.room.view());
  unchanged(f, () => act(f, MEMBERS[0], { op: 'cook', recipe: 'soup' }), 'living_paused');
  unchanged(f, () => f.room.advance(1000000));
  f.room.flush();
  const sentinel = path.join(f.root, 'data', 'messages.jsonl');
  fs.writeFileSync(sentinel, 'existing operational data\n');
  assert.deepEqual(f.restart().view(), f.room.view());
  assert.equal(f.room.resume().changed, true);
  unchanged(f, () => f.room.resume());
  ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'soup' }));
  f.room.flush();
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing operational data\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)).sort(), ['living.json', 'messages.jsonl']);
  assert.deepEqual(fs.readdirSync(f.root), ['data']);
});

test('view is a deep internal snapshot; injected membership and exported recipes cannot mutate the engine', (t) => {
  const ids = [...MEMBERS];
  const f = fixture(t, { members: ids });
  ids.push('intruder');
  startGame(f); serve(f);
  const before = f.room.view();
  const view = f.room.view();
  view.meal.eatenBy.push('intruder'); view.meal.remaining = 0;
  view.game.players[0] = 'intruder'; view.game.board[0] = 'X';
  view.game.winningCells.push(0); view.events[0].text = 'rewritten'; view.revision++;
  assert.deepEqual(f.room.view(), before);
  unchanged(f, () => act(f, 'intruder', { op: 'game_create' }), 'unknown_member');
  assert.throws(() => { LIVING_RECIPES.tea.durationMs = 0; }, TypeError);
  assert.throws(() => { LIVING_RECIPES.other = {}; }, TypeError);
});

test('members accept ID arrays, sets and maps keyed by ID; missing or malformed membership fails closed', (t) => {
  for (const members of [new Set(MEMBERS), NAMES]) {
    const f = fixture(t, { members });
    ok(act(f, MEMBERS[0], { op: 'game_create' }));
  }
  const f = fixture(t, { members: [] });
  unchanged(f, () => act(f, MEMBERS[0], { op: 'game_create' }), 'unknown_member');
  for (const members of [null, 'member-a', ['a', 'a'], [''], ['a\nb'], [{}]]) {
    assert.throws(() => new LivingRoom(f.root, { members }), { code: 'invalid_members' });
  }
});

test('all allowed recipes take 15–90 seconds and complete once at the exact deadline', (t) => {
  assert.deepEqual(Object.keys(LIVING_RECIPES), ['soup', 'burger', 'tea', 'toast', 'dumplings', 'cookies', 'fruit']);
  for (const [recipe, spec] of Object.entries(LIVING_RECIPES)) {
    const f = fixture(t);
    assert.ok(spec.durationMs >= 15000 && spec.durationMs <= 90000);
    ok(act(f, MEMBERS[0], { op: 'cook', recipe }));
    const m = f.room.view().meal;
    assert.equal(m.readyAt, f.now() + spec.durationMs);
    assert.equal(m.remaining, 4); assert.equal(m.servings, 4); assert.equal(m.status, 'cooking');
    unchanged(f, () => act(f, MEMBERS[1], { op: 'cook', recipe: 'toast' }), 'meal_active');
    unchanged(f, () => act(f, MEMBERS[1], mealCommand(f, 'serve')), 'meal_not_ready');
    unchanged(f, () => f.room.advance(m.readyAt - 1));
    const previous = f.room.view();
    assert.equal(f.room.advance(m.readyAt).changed, true);
    assert.equal(f.room.view().meal.status, 'ready');
    assert.equal(f.room.view().meal.revision, m.revision + 1);
    assert.equal(f.room.view().revision, previous.revision + 1);
    unchanged(f, () => f.room.advance(m.readyAt));
    unchanged(f, () => f.room.advance(m.readyAt + 100000));
    assert.equal(f.restart().advance(m.readyAt + 200000).changed, false);
    assert.deepEqual(f.restart().view(), f.room.view());
  }
});

test('serve and eat require current meal scope, permit one serving per member, and replace only finished meals', (t) => {
  const f = fixture(t);
  serve(f);
  const oldId = f.room.view().meal.id;
  unchanged(f, () => act(f, MEMBERS[0], { op: 'cook', recipe: 'soup' }), 'meal_active');
  unchanged(f, () => act(f, MEMBERS[0], mealCommand(f, 'serve')), 'meal_not_ready');
  const simultaneous = mealCommand(f, 'eat');
  ok(act(f, MEMBERS[0], simultaneous));
  unchanged(f, () => act(f, MEMBERS[1], simultaneous), 'stale_revision');
  unchanged(f, () => act(f, MEMBERS[0], mealCommand(f, 'eat')), 'already_eaten');
  for (const actor of MEMBERS.slice(1, 4)) ok(act(f, actor, mealCommand(f, 'eat')));
  assert.equal(f.room.view().meal.status, 'finished');
  assert.equal(f.room.view().meal.remaining, 0);
  assert.deepEqual(f.room.view().meal.eatenBy, MEMBERS.slice(0, 4));
  unchanged(f, () => act(f, MEMBERS[4], mealCommand(f, 'eat')), 'meal_not_served');
  const stale = mealCommand(f, 'eat');
  ok(act(f, MEMBERS[1], { op: 'cook', recipe: 'burger' }));
  assert.notEqual(f.room.view().meal.id, oldId);
  assert.equal(f.room.view().meal.revision, 1);
  unchanged(f, () => act(f, MEMBERS[4], { ...stale, revision: 1 }), 'stale_revision');
  assert.deepEqual(f.restart().view(), f.room.view());
});

test('open invitation starts blank; only two distinct players can join and make legal moves in turn', (t) => {
  const f = fixture(t);
  ok(act(f, MEMBERS[0], { op: 'game_create' }));
  const waiting = f.room.view().game;
  assert.deepEqual(waiting.board, Array(9).fill(null));
  assert.deepEqual(waiting.players, [MEMBERS[0]]);
  assert.equal(waiting.turn, null); assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.expiresAt, f.now() + 300000);
  unchanged(f, () => act(f, MEMBERS[0], gameCommand(f, 'game_join')), 'already_joined');
  unchanged(f, () => act(f, MEMBERS[0], gameCommand(f, 'game_move', { cell: 0 })), 'game_waiting');
  unchanged(f, () => act(f, MEMBERS[1], gameCommand(f, 'game_leave')), 'not_player');
  unchanged(f, () => act(f, MEMBERS[1], { op: 'game_create' }), 'game_active');
  const invite = gameCommand(f, 'game_join');
  ok(act(f, MEMBERS[1], invite));
  unchanged(f, () => act(f, MEMBERS[2], invite), 'stale_revision');
  unchanged(f, () => act(f, MEMBERS[2], gameCommand(f, 'game_join')), 'game_full');
  assert.equal(f.room.view().game.turn, MEMBERS[0]);
  unchanged(f, () => act(f, MEMBERS[1], gameCommand(f, 'game_move', { cell: 0 })), 'not_your_turn');
  unchanged(f, () => act(f, MEMBERS[2], gameCommand(f, 'game_move', { cell: 0 })), 'not_player');
  for (const cell of [-1, 9, 0.5, '0', null, NaN, Infinity]) {
    unchanged(f, () => move(f, cell), 'invalid_cell');
  }
  ok(move(f, 0));
  unchanged(f, () => move(f, 0), 'occupied_cell');
  ok(move(f, 4));
  assert.deepEqual(f.room.view().game.board, ['X', null, null, null, 'O', null, null, null, null]);
  assert.deepEqual(f.restart().view(), f.room.view());
});

test('both marks can win; double-line victories and draws finish without any automatic moves', (t) => {
  for (const [moves, result, winner, cells] of [
    [[0, 3, 1, 4, 2], 'win', MEMBERS[0], [0, 1, 2]],
    [[0, 3, 1, 4, 8, 5], 'win', MEMBERS[1], [3, 4, 5]],
    [[0, 1, 2, 3, 6, 5, 8, 7, 4], 'win', MEMBERS[0], [0, 4, 8]],
    [[0, 1, 2, 4, 3, 5, 7, 6, 8], 'draw', null, []],
  ]) {
    const f = fixture(t);
    startGame(f);
    for (const cell of moves) ok(move(f, cell));
    const g = f.room.view().game;
    assert.equal(g.status, 'finished'); assert.equal(g.result, result);
    assert.equal(g.winner, winner); assert.deepEqual(g.winningCells, cells);
    assert.equal(g.turn, null); assert.equal(g.expiresAt, null);
    assert.equal(g.board.filter((v) => v !== null).length, moves.length);
    for (const op of ['game_join', 'game_move', 'game_leave']) {
      unchanged(f, () => act(f, MEMBERS[0], gameCommand(f, op, op === 'game_move' ? { cell: 8 } : {})), 'game_finished');
    }
    unchanged(f, () => f.room.advance(f.now() + 1000000));
    assert.deepEqual(f.restart().view(), f.room.view());
  }
});

test('leave abandons waiting or playing games, and old game IDs fail even when revisions match a new game', (t) => {
  for (const joined of [false, true]) {
    const f = fixture(t);
    ok(act(f, MEMBERS[0], { op: 'game_create' }));
    const oldInvite = gameCommand(f, 'game_join');
    if (joined) { ok(act(f, MEMBERS[1], oldInvite)); ok(move(f, 4)); }
    const board = f.room.view().game.board;
    ok(act(f, MEMBERS[0], gameCommand(f, 'game_leave')));
    assert.equal(f.room.view().game.result, 'abandoned');
    assert.deepEqual(f.room.view().game.board, board);
    assert.equal(f.room.view().game.winner, null);
    assert.deepEqual(f.restart().view(), f.room.view());
    ok(act(f, MEMBERS[2], { op: 'game_create' }));
    assert.equal(f.room.view().game.revision, oldInvite.revision);
    unchanged(f, () => act(f, MEMBERS[1], oldInvite), 'stale_revision');
    for (const op of ['game_move', 'game_leave']) {
      unchanged(f, () => act(f, MEMBERS[0], { ...oldInvite, op, ...(op === 'game_move' ? { cell: 0 } : {}) }), 'stale_revision');
    }
  }
});

test('meal and game revisions are independent while each committed transaction increments the global revision', (t) => {
  const f = fixture(t);
  serve(f); startGame(f);
  const eat = mealCommand(f, 'eat'), moveCommand = gameCommand(f, 'game_move', { cell: 4 });
  const before = f.room.view();
  ok(act(f, MEMBERS[0], eat));
  assert.equal(f.room.view().game.revision, before.game.revision);
  ok(act(f, MEMBERS[0], moveCommand));
  assert.equal(f.room.view().meal.revision, before.meal.revision + 1);
  assert.equal(f.room.view().revision, before.revision + 2);
});

test('invalid commands never advance overdue timers or modify state and reject missing scopes', (t) => {
  const f = fixture(t);
  ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'tea' }));
  startGame(f);
  f.setTime(f.room.view().game.expiresAt + 1);
  const getter = Object.defineProperty({}, 'op', { enumerable: true, get() { throw Error('must not execute'); } });
  const commands = [null, [], 'cook', {}, { op: 'dance' }, { op: 'toString' }, getter,
    { op: 'cook' }, { op: 'cook', recipe: 'tea', other: true }, { op: 'serve' }, { op: 'eat', mealId: 'x' },
    { op: 'game_create', recipe: 'tea' }, { op: 'game_join', gameId: 'x' },
    { op: 'game_move', gameId: 'x', revision: 1 }, { op: 'game_leave', revision: 1 },
    { ...mealCommand(f, 'eat'), revision: '1' }, { ...gameCommand(f, 'game_join'), revision: null }];
  for (const command of commands) unchanged(f, () => act(f, MEMBERS[0], command), 'invalid_command');
  for (const recipe of ['pizza', '__proto__', 'constructor', null, {}, 'SOUP']) {
    unchanged(f, () => act(f, MEMBERS[0], { op: 'cook', recipe }), 'invalid_recipe');
  }
  unchanged(f, () => act(f, 'outsider', { op: 'cook', recipe: 'tea' }), 'unknown_member');
  for (const at of [-1, NaN, Infinity, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    unchanged(f, () => f.room.act(MEMBERS[0], { op: 'game_create' }, at), 'invalid_time');
  }
  assert.equal(f.room.view().meal.status, 'cooking');
  assert.equal(f.room.view().game.status, 'playing');
});

test('validate and dryRun perform no writes or publication, and act rechecks after a validated command becomes stale', (t) => {
  const f = fixture(t);
  const create = { op: 'game_create' };
  const write = t.mock.method(fs, 'writeFileSync', () => { throw Error('dry run wrote'); });
  const rename = t.mock.method(fs, 'renameSync', () => { throw Error('dry run renamed'); });
  assert.equal(unchanged(f, () => f.room.validate(MEMBERS[0], create)).ok, true);
  assert.equal(unchanged(f, () => f.room.act(MEMBERS[0], create, f.now(), { dryRun: true })).ok, true);
  assert.equal(write.mock.callCount(), 0); assert.equal(rename.mock.callCount(), 0);
  write.mock.restore(); rename.mock.restore();
  startGame(f);
  const command = gameCommand(f, 'game_move', { cell: 0 });
  assert.equal(unchanged(f, () => f.room.validate(MEMBERS[0], command)).ok, true);
  unchanged(f, () => f.room.validate(MEMBERS[1], command), 'not_your_turn');
  ok(move(f, 4));
  unchanged(f, () => f.room.act(MEMBERS[0], command), 'stale_revision');
});

test('pause excludes stopped time across restarts, keeps boards unchanged, and invalidates pre-pause commands', (t) => {
  const f = fixture(t);
  ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'soup' }));
  startGame(f);
  const oldMove = gameCommand(f, 'game_move', { cell: 0 });
  const before = f.room.view();
  f.setTime(11000);
  assert.equal(f.room.pause().changed, true);
  const paused = f.room.view();
  assert.equal(paused.pausedAt, 11000);
  assert.equal(paused.game.revision, before.game.revision + 1);
  assert.equal(paused.meal.revision, before.meal.revision + 1);
  unchanged(f, () => f.room.pause(999999));
  unchanged(f, () => f.room.advance(999999));
  unchanged(f, () => act(f, MEMBERS[0], gameCommand(f, 'game_move', { cell: 0 })), 'living_paused');
  assert.deepEqual(f.restart().view(), paused);
  const restarted = f.restart();
  assert.throws(() => restarted.resume(10999), { code: 'invalid_time' });
  assert.deepEqual(restarted.view(), paused);
  assert.equal(restarted.resume(511000).changed, true);
  const resumed = restarted.view();
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.meal.readyAt, before.meal.readyAt + 500000);
  assert.equal(resumed.game.expiresAt, before.game.expiresAt + 500000);
  assert.deepEqual(resumed.game.board, before.game.board);
  assert.equal(restarted.act(MEMBERS[0], oldMove, 511000).error, 'stale_revision');
  assert.equal(restarted.advance(resumed.meal.readyAt - 1).changed, false);
  assert.equal(restarted.advance(resumed.meal.readyAt).changed, true);
  assert.equal(restarted.view().meal.status, 'ready');
  assert.deepEqual(f.restart().view(), restarted.view());
});

test('waiting and playing games expire at 5/3 minutes, legal activity resets the deadline, and no turn is fabricated', (t) => {
  for (const joined of [false, true]) {
    const f = fixture(t);
    ok(act(f, MEMBERS[0], { op: 'game_create' }));
    assert.equal(f.room.view().game.expiresAt, 301000);
    if (joined) {
      f.setTime(11000); ok(act(f, MEMBERS[1], gameCommand(f, 'game_join')));
      assert.equal(f.room.view().game.expiresAt, 191000);
      f.setTime(21000); ok(move(f, 4));
      assert.equal(f.room.view().game.expiresAt, 201000);
      unchanged(f, () => act(f, MEMBERS[0], gameCommand(f, 'game_move', { cell: 0 })), 'not_your_turn');
    }
    const g = f.room.view().game;
    unchanged(f, () => f.room.advance(g.expiresAt - 1));
    f.setTime(g.expiresAt);
    const command = gameCommand(f, joined ? 'game_move' : 'game_join', joined ? { cell: 0 } : {});
    unchanged(f, () => act(f, MEMBERS[1], command), 'game_expired');
    assert.equal(f.room.advance().changed, true);
    assert.equal(f.room.view().game.result, 'expired');
    assert.equal(f.room.view().game.winner, null); assert.equal(f.room.view().game.turn, null);
    assert.equal(f.room.view().game.expiresAt, null);
    assert.deepEqual(f.room.view().game.board, g.board);
    unchanged(f, () => f.room.advance());
    assert.deepEqual(f.restart().view(), f.room.view());
    ok(act(f, MEMBERS[2], { op: 'game_create' }));
  }
});

test('one advance combines cooking completion and game expiry into one persisted event/result', (t) => {
  const f = fixture(t);
  ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'soup' }));
  startGame(f);
  const before = f.room.view();
  const result = f.room.advance(before.game.expiresAt);
  assert.equal(result.changed, true); assert.match(result.text, /수프.*준비.*삼목.*종료/u);
  const after = f.room.view();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.events.length, before.events.length + 1);
  assert.equal(after.events.at(-1).text, result.text);
  assert.equal(after.meal.revision, before.meal.revision + 1);
  assert.equal(after.game.revision, before.game.revision + 1);
  unchanged(f, () => f.room.advance(before.game.expiresAt + 1));
});

test('I/O failures at write, fsync and rename retain both snapshots and file bytes and remove temporary files', (t) => {
  for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const f = fixture(t);
    const original = fs[method];
    const mock = t.mock.method(fs, method, () => { const error = Error(`private ${f.root}`); error.code = 'EIO'; throw error; });
    const result = unchanged(f, () => act(f, MEMBERS[0], { op: 'cook', recipe: 'soup' }), 'living_persist_failed');
    assert.ok(!result.text.includes(f.root)); assert.ok(!JSON.stringify(result).includes('EIO'));
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['living.json']);
    mock.mock.restore(); assert.equal(fs[method], original);
    ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'soup' }));
    assert.deepEqual(f.restart().view(), f.room.view());
  }
});

test('failed multi-change advance, pause and resume publish nothing and can be retried exactly once', (t) => {
  const f = fixture(t);
  ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'tea' })); startGame(f);
  for (const operation of [() => f.room.pause(), () => f.room.resume(), () => f.room.advance(301000)]) {
    const before = f.room.view(), saved = bytes(f);
    const mock = t.mock.method(fs, 'renameSync', () => { throw Error('private path'); });
    assert.throws(operation, { code: 'living_persist_failed' });
    assert.deepEqual(f.room.view(), before); assert.equal(bytes(f), saved);
    mock.mock.restore();
    assert.equal(operation().changed, true);
  }
  assert.equal(f.room.view().meal.status, 'ready');
  assert.equal(f.room.view().game.result, 'expired');
  unchanged(f, () => f.room.advance(301000));
});

test('failed initial persistence throws without a partial destination, and construction succeeds after retry', (t) => {
  const f = fixture(t);
  const newRoot = path.join(f.root, 'new-room');
  const newFile = path.join(newRoot, 'data', 'living.json');
  const mock = t.mock.method(fs, 'renameSync', () => { throw Error('rename failed'); });
  assert.throws(() => new LivingRoom(newRoot, { members: MEMBERS, now: f.now }), { code: 'living_persist_failed' });
  assert.equal(fs.existsSync(newFile), false);
  assert.deepEqual(fs.readdirSync(path.dirname(newFile)), []);
  mock.mock.restore();
  const room = new LivingRoom(newRoot, { members: MEMBERS, now: f.now });
  assert.equal(room.view().pausedAt, f.now());
  assert.deepEqual(JSON.parse(fs.readFileSync(newFile, 'utf8')), room.view());
});

test('malformed, oversized, invalid UTF-8 and unreadable saved state fails closed without replacing evidence', (t) => {
  const f = fixture(t);
  for (const content of ['{', 'null', '{}', '[]', ' '.repeat(65537), Buffer.from([0xff, 0xfe])]) {
    fs.writeFileSync(f.file, content);
    const before = fs.readFileSync(f.file);
    assert.throws(() => f.restart(), (error) => error instanceof LivingError && error.code === 'invalid_living_state'
      && !error.message.includes(f.root));
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
  const content = fs.readFileSync(f.file);
  const mock = t.mock.method(fs, 'readFileSync', () => { const error = Error(f.root); error.code = 'EACCES'; throw error; });
  assert.throws(() => f.restart(), { code: 'invalid_living_state' });
  mock.mock.restore(); assert.deepEqual(fs.readFileSync(f.file), content);
});

test('saved semantic corruption rejects wrong players, marks, turns, winning lines, servings, deadlines and event history', (t) => {
  const f = fixture(t);
  serve(f); startGame(f); ok(move(f, 0));
  const valid = f.room.view();
  const corruptions = [
    (s) => { s.version = 2; }, (s) => { delete s.pausedAt; }, (s) => { s.pausedAt = -1; },
    (s) => { s.revision = 0; }, (s) => { s.secret = 'unrelated data'; },
    (s) => { s.meal.recipe = 'pizza'; }, (s) => { s.meal.label = '잘못된 메뉴'; },
    (s) => { s.meal.remaining = 0; }, (s) => { s.meal.servings = 5; },
    (s) => { s.meal.eatenBy = [MEMBERS[0], MEMBERS[0]]; s.meal.remaining = 2; },
    (s) => { s.meal.cook = 'outsider'; }, (s) => { s.meal.readyAt = '100'; },
    (s) => { s.meal.status = 'ready'; s.meal.eatenBy = [MEMBERS[0]]; s.meal.remaining = 3; },
    (s) => { s.game.board[0] = MEMBERS[0]; }, (s) => { s.game.board.pop(); },
    (s) => { s.game.board[2] = 'X'; }, (s) => { s.game.turn = MEMBERS[0]; },
    (s) => { s.game.players[1] = MEMBERS[0]; }, (s) => { s.game.players[1] = 'outsider'; },
    (s) => { s.game.expiresAt = null; }, (s) => { s.game.status = 'paused'; },
    (s) => { s.game.winner = MEMBERS[0]; }, (s) => { s.game.winningCells = [0, 1, 2]; },
    (s) => { s.game.board = ['X', 'X', 'X', 'O', 'O', null, null, null, null]; },
    (s) => { s.events = []; }, (s) => { s.events.push(s.events[0]); },
    (s) => { s.events[1].id = s.events[0].id; }, (s) => { s.events[0].at = -1; },
  ];
  for (const corrupt of corruptions) {
    const state = structuredClone(valid); corrupt(state);
    const encoded = JSON.stringify(state); fs.writeFileSync(f.file, encoded);
    assert.throws(() => f.restart(), { code: 'invalid_living_state' });
    assert.equal(bytes(f), encoded);
  }
});

test('impossible terminal boards and altered victory metadata are rejected on reload', (t) => {
  const f = fixture(t); startGame(f);
  for (const cell of [0, 3, 1, 4, 2]) ok(move(f, cell));
  const valid = f.room.view();
  for (const corrupt of [
    (g) => { g.winner = MEMBERS[1]; }, (g) => { g.winningCells = [3, 4, 5]; },
    (g) => { g.result = 'draw'; }, (g) => { g.result = 'expired'; },
    (g) => { g.board[5] = 'O'; }, (g) => { g.expiresAt = 999999; },
  ]) {
    const state = structuredClone(valid); corrupt(state.game);
    const encoded = JSON.stringify(state); fs.writeFileSync(f.file, encoded);
    assert.throws(() => f.restart(), { code: 'invalid_living_state' });
    assert.equal(bytes(f), encoded);
  }
});

test('events remain the last eight changes, disk usage stays below 64 KiB, and flush is idempotent', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) {
    ok(act(f, MEMBERS[0], { op: 'game_create' }));
    ok(act(f, MEMBERS[0], gameCommand(f, 'game_leave')));
  }
  const state = f.room.view();
  assert.equal(state.revision, 61); assert.equal(state.events.length, 8);
  assert.equal(new Set(state.events.map((e) => e.id)).size, 8);
  assert.ok(fs.statSync(f.file).size <= 64 * 1024);
  assert.deepEqual(f.restart().view(), state);
  const mock = t.mock.method(fs, 'writeFileSync', () => { throw Error('idempotent flush wrote'); });
  f.room.flush(); assert.equal(mock.mock.callCount(), 0);
});

test('idle living context reports state without inviting cooking, props or a game', (t) => {
  const f = fixture(t), saved = bytes(f), before = f.room.view();
  const text = f.room.summary();
  assert.match(text, /주방: 진행 중인 식사 없음/);
  assert.match(text, /revision=0/); // Keep the revision needed if an optional action is chosen.
  assert.doesNotMatch(text, /"op"|판 좌표|메뉴|새 게임 가능/);
  assert.ok(text.length < 220);
  assert.equal(bytes(f), saved);
  assert.deepEqual(f.room.view(), before);
  // Removing repeated suggestions does not disable the tools.
  ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'fruit' }));
  ok(act(f, MEMBERS[1], { op: 'game_create' }));
});

test('finished activities do not prompt another meal or game in each turn', (t) => {
  const f = fixture(t); serve(f);
  for (const actor of MEMBERS.slice(0, 4)) ok(act(f, actor, mealCommand(f, 'eat')));
  startGame(f); ok(act(f, MEMBERS[0], gameCommand(f, 'game_leave')));
  const before = f.room.view(), saved = bytes(f), text = f.room.summary();
  assert.match(text, /식사 완료/);
  assert.match(text, /종료/);
  assert.doesNotMatch(text, /"op"|판 좌표|메뉴|새 게임 가능/);
  assert.deepEqual(f.room.view(), before); assert.equal(bytes(f), saved);
});

test('Korean summary maps every actor, includes coordinates/legal cells and only current scope examples', (t) => {
  const f = fixture(t); serve(f); startGame(f);
  ok(act(f, MEMBERS[2], mealCommand(f, 'eat'))); ok(move(f, 4));
  const before = f.room.view(), saved = bytes(f);
  const text = f.room.summary((id) => NAMES[id]);
  for (const id of MEMBERS) assert.ok(!text.includes(id));
  for (const name of ['가람', '나래', '다온']) assert.ok(text.includes(name));
  assert.match(text, /나래 차례/u); assert.match(text, /합법 수\(cell\): 0,1,2,3,5,6,7,8/u);
  assert.match(text, /0:· 1:· 2:· \/ 3:· 4:X 5:· \/ 6:· 7:· 8:·/u);
  assert.ok(text.includes(JSON.stringify(mealCommand(f, 'eat'))));
  assert.ok(text.includes(JSON.stringify(gameCommand(f, 'game_move', { cell: 0 }))));
  assert.ok(text.includes(`${JSON.stringify(gameCommand(f, 'game_move', { cell: 0 }))} cell은 예시값입니다. 현재 판을 보고 승리와 방어를 고려해 합법 수 중 직접 선택해 주세요.`));
  assert.ok(text.length < 1400);
  assert.deepEqual(f.room.view(), before); assert.equal(bytes(f), saved);
  f.room.pause(); assert.match(f.room.summary((id) => NAMES[id]), /합법 수\(cell\): 없음\(일시정지\)/u);
});

test('meal_clear requires current scope and only the cook can cancel cooking, with dryRun preserving it', (t) => {
  const f = fixture(t);
  ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'soup' }));
  const clear = mealCommand(f, 'meal_clear'), before = f.room.view();
  unchanged(f, () => act(f, MEMBERS[1], clear), 'not_cook');
  unchanged(f, () => act(f, MEMBERS[0], { op: 'meal_clear' }), 'invalid_command');
  unchanged(f, () => act(f, MEMBERS[0], { ...clear, revision: 0 }), 'invalid_command');
  assert.equal(unchanged(f, () => f.room.validate(MEMBERS[0], clear)).ok, true);
  assert.equal(unchanged(f, () => f.room.act(MEMBERS[0], clear, f.now(), { dryRun: true })).ok, true);
  assert.match(ok(act(f, MEMBERS[0], clear)).text, /조리를 취소했습니다/u);
  assert.equal(f.room.view().meal, null);
  assert.equal(f.room.view().revision, before.revision + 1);
  unchanged(f, () => f.room.advance(before.meal.readyAt));
  unchanged(f, () => act(f, MEMBERS[0], clear), 'stale_revision');
  ok(act(f, MEMBERS[1], { op: 'cook', recipe: 'toast' }));
  assert.equal(f.room.view().meal.revision, clear.revision);
  unchanged(f, () => act(f, MEMBERS[0], clear), 'stale_revision');
  assert.deepEqual(f.restart().view(), f.room.view());
});

test('any member can clear ready or partially served food without inventing eating; a new meal can then start', (t) => {
  for (const served of [false, true]) {
    const f = fixture(t);
    ok(act(f, MEMBERS[0], { op: 'cook', recipe: 'tea' }));
    f.setTime(f.room.view().meal.readyAt); f.room.advance();
    if (served) {
      ok(act(f, MEMBERS[1], mealCommand(f, 'serve')));
      ok(act(f, MEMBERS[2], mealCommand(f, 'eat')));
    }
    const before = f.room.view(), clear = mealCommand(f, 'meal_clear');
    const result = ok(act(f, MEMBERS[3], clear));
    assert.match(result.text, new RegExp(`${served ? 3 : 4}인분을 정리했습니다`));
    assert.doesNotMatch(result.text, /먹|식사를 마쳤/u);
    const after = f.room.view();
    assert.equal(after.meal, null); assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.game, before.game);
    assert.equal(after.events.at(-1).text, result.text);
    assert.deepEqual(f.restart().view(), after);
    unchanged(f, () => act(f, MEMBERS[4], clear), 'stale_revision');
    ok(act(f, MEMBERS[4], { op: 'cook', recipe: 'burger' }));
    assert.deepEqual(f.room.view().meal.eatenBy, []);
    assert.equal(f.room.view().meal.remaining, 4);
  }
});

test('cleanup validated before another diner eats becomes stale; failed cleanup persistence retains remaining food', (t) => {
  const f = fixture(t); serve(f);
  const clear = mealCommand(f, 'meal_clear');
  assert.equal(unchanged(f, () => f.room.validate(MEMBERS[3], clear)).ok, true);
  ok(act(f, MEMBERS[0], mealCommand(f, 'eat')));
  unchanged(f, () => act(f, MEMBERS[3], clear), 'stale_revision');
  const current = mealCommand(f, 'meal_clear');
  const mock = t.mock.method(fs, 'renameSync', () => { throw Error('private location'); });
  unchanged(f, () => act(f, MEMBERS[3], current), 'living_persist_failed');
  mock.mock.restore();
  ok(act(f, MEMBERS[3], current));
  assert.equal(f.room.view().meal, null);
  assert.deepEqual(f.restart().view(), f.room.view());
});

test('empty finished meals reject cleanup, and notices/errors/events use polite system wording', (t) => {
  const f = fixture(t); serve(f);
  for (const actor of MEMBERS.slice(0, 4)) ok(act(f, actor, mealCommand(f, 'eat')));
  const result = unchanged(f, () => act(f, MEMBERS[4], mealCommand(f, 'meal_clear')), 'meal_empty');
  assert.equal(result.text, '정리할 음식이 없습니다.');
  startGame(f);
  for (const cell of [0, 3, 1, 4, 2]) ok(move(f, cell));
  for (const event of f.room.view().events) {
    assert.doesNotMatch(event.text, /(?:했어|됐어|있어|없어|차례야|무승부야|줘)[.!]/u);
    assert.match(event.text, /(?:습니다|입니다)[.!]/u);
  }
  assert.match(f.room.summary((id) => NAMES[id]), /가람 승리/u);
});

test('summary does not advertise legal moves after a game expires but before advance runs', (t) => {
  const f = fixture(t); startGame(f);
  f.setTime(f.room.view().game.expiresAt);
  const before = f.room.view(), saved = bytes(f);
  const summary = f.room.summary((id) => NAMES[id]);
  assert.match(summary, /시간 만료 처리 대기.*합법 수: 없음/u);
  assert.doesNotMatch(summary, /"op":"game_(?:join|move|leave)"/u);
  assert.deepEqual(f.room.view(), before); assert.equal(bytes(f), saved);
});
