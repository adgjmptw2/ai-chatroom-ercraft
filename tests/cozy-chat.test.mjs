import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CozyChatHints, photoSubjectsArriving } from '../lib/cozy-chat.mjs';
import { World } from '../lib/world.mjs';
import { buildHouse } from '../lib/house.mjs';
import { LivingRoom } from '../lib/living.mjs';
import { applyLivingAction } from '../lib/living-integration.mjs';

const IDS = ['gpt', 'gemini', 'claude', 'deepseek'];
const NOW = Date.UTC(2026, 9, 2);
const PARENT = path.dirname(fileURLToPath(import.meta.url));

function fixture(t) {
  // Temporary data stays inside this workspace; never open the runtime data.
  const root = fs.mkdtempSync(path.join(PARENT, '.cozy-chat-fixture-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(PARENT));
    assert.ok(path.basename(target).startsWith('.cozy-chat-fixture-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'world.json'), JSON.stringify(buildHouse()));
  const world = new World(root, IDS);
  // Furniture execution is real; only its delayed persistence is disabled.
  const save = t.mock.method(world, 'save', () => {});
  return { world, root, save, hints: new CozyChatHints() };
}

function sit(world, actor, spot = 'sofa-1') {
  const at = world.home.furniture[spot].at;
  const { block, shape, ...pose } = world.furniturePose(at);
  assert.equal(pose.posture, 'sit');
  world.avatars[actor] = { ...pose, furniture: { at: [...at], shape, block } };
  return world.avatars[actor];
}

function travelling(world, actor, moveId = NOW, route = null) {
  const a = world.avatars[actor];
  const destination = { x: a.x, y: a.y, z: a.z };
  const move = { avatar: a, moveId, path: route || [{ ...destination, x: a.x + 8 }, destination] };
  world.movements.set(actor, move);
  return move;
}

const hint = (f, actor = 'gemini', options = {}) => f.hints.hint(f.world, actor, { now: NOW, ...options });
const command = text => JSON.parse(text.match(/\{"living":\{[^}]+\}\}/)?.[0] || '{}').living;
const photo = (f, actor = 'gpt', now = NOW, options = {}) => hint(f, actor, { now, photoAvailable: true, ...options });

test('photo admission shares the arrival delay and ignores unselected travellers', t => {
  const f=fixture(t);
  sit(f.world,'gpt');
  travelling(f.world,'gpt',NOW);
  const avatars=f.world.avatarView();
  assert.equal(photoSubjectsArriving(avatars,[{id:'gpt'}],NOW),true);
  assert.equal(photoSubjectsArriving(avatars,[{id:'claude'}],NOW),false);
  assert.equal(photoSubjectsArriving(avatars,[{id:'gpt'}],NOW+2999),true);
  assert.equal(photoSubjectsArriving(avatars,[{id:'gpt'}],NOW+3000),false);
  avatars.gpt.path=[];
  assert.equal(photoSubjectsArriving(avatars,[{id:'gpt'}],NOW+3000),true);
});

test('scattered residents get no hint, including no instruction to choose the first sofa', t => {
  const f = fixture(t);
  for (const actor of IDS) {
    assert.equal(hint(f, actor), '');
    assert.equal(photo(f, actor, NOW + 600_000), '');
  }
  assert.equal(f.save.mock.callCount(), 0);
});

test('offers only the free adjacent sofa to the caller, once per actor and seated combo', t => {
  const f = fixture(t);
  sit(f.world, 'gpt');
  const text = hint(f, 'gemini', { nameOf: id => id === 'gpt' ? '아디나' : '손님' });
  assert.match(text, /아디나.*원하면 본인만/);
  assert.deepEqual(command(text), { op: 'relax', spot: 'sofa-2' });
  assert.doesNotMatch(text, /move|useFurniture|bed|식사|요리|모두|전원/);
  assert.equal(hint(f), '');
  assert.equal(hint(f, 'gemini', { now: NOW + 600_000 }), '');
  assert.deepEqual(command(hint(f, 'claude')), { op: 'relax', spot: 'sofa-2' });
  assert.equal(hint(f, 'gpt'), '');

  sit(f.world, 'gpt', 'sofa-4');
  assert.deepEqual(command(hint(f)), { op: 'relax', spot: 'sofa-3' });
  sit(f.world, 'gpt', 'sofa-1');
  assert.equal(hint(f), '', 'remember a previously offered combo within the bounded history');
});

test('adjacency uses actual anchors, not sofa numbering or any empty bench elsewhere', t => {
  const f = fixture(t);
  sit(f.world, 'gpt', 'sofa-4');
  const target = f.world.home.furniture['sofa-3'];
  target.at = [14, 4, 31];
  f.world.blocks.set(target.at.join(','), 'casa_sage/bench/e');
  assert.equal(f.world.furniturePose(target.at).posture, 'sit');
  assert.equal(hint(f), '');
});

test('any avatar furniture reservation or coordinates block the only adjacent seat', async t => {
  for (const [label, block] of [
    ['unlisted actor at seat coordinates', (w, pose) => { w.avatars.visitor = { ...pose, posture: 'stand' }; }],
    ['standing at floor height', (w, pose) => { w.avatars.visitor = { x: pose.x, y: 4, z: pose.z, posture: 'stand' }; }],
    ['remote stale furniture link', w => { w.avatars.visitor = { x: 20, y: 4, z: 30, furniture: { at: [10, 4, 33] } }; }],
    ['arriving resident', w => { sit(w, 'claude', 'sofa-2'); travelling(w, 'claude'); }],
  ]) await t.test(label, t => {
    const f = fixture(t);
    sit(f.world, 'gpt');
    block(f.world, f.world.furniturePose([10, 4, 33]));
    assert.equal(hint(f), '', 'nonadjacent sofa-3/4 are not alternatives');
  });
});

test('rejects missing, replaced, unsupported, blocked or malformed actual target furniture', async t => {
  for (const [label, invalidate] of [
    ['missing block', (w, f) => w.blocks.delete(f.at.join(','))],
    ['chair replacement', (w, f) => w.blocks.set(f.at.join(','), 'casa_sage/chair/e')],
    ['bed replacement', (w, f) => w.blocks.set(f.at.join(','), 'casa_sage/bed/e')],
    ['workbench replacement', (w, f) => w.blocks.set(f.at.join(','), 'casa_sage/workbench/e')],
    ['missing support', w => w.blocks.delete('10,3,33')],
    ['blocked headroom', w => w.blocks.set('10,5,33', 'stone')],
    ['wrong metadata shape', (w, f) => { f.shape = 'bed'; }],
    ['noninteger anchor', (w, f) => { f.at = [10, 4, 33.1]; }],
    ['missing anchor', (w, f) => { delete f.at; }],
    ['out of bounds', (w, f) => { f.at = [100, 4, 33]; }],
    ['duplicate anchor', (w, f) => { f.at = [10, 4, 32]; }],
  ]) await t.test(label, t => {
    const f = fixture(t);
    sit(f.world, 'gpt');
    invalidate(f.world, f.world.home.furniture['sofa-2']);
    assert.equal(hint(f), '');
  });
});

test('a settled companion requires matching actual link, block, shape, coordinates and posture', async t => {
  for (const [label, invalidate] of [
    ['stale block', (w, a) => { a.furniture.block = 'planks/bench/e'; }],
    ['wrong shape', (w, a) => { a.furniture.shape = 'bed'; }],
    ['wrong link', (w, a) => { a.furniture.at = [10, 4, 35]; }],
    ['missing link', (w, a) => { delete a.furniture; }],
    ['wrong coordinates', (w, a) => { a.x++; }],
    ['wrong height', (w, a) => { a.y = 4; }],
    ['not sitting', (w, a) => { a.posture = 'stand'; }],
    ['removed furniture', w => w.blocks.delete('10,4,32')],
    ['ambiguous occupants', (w, a) => { w.avatars.visitor = structuredClone(a); }],
  ]) await t.test(label, t => {
    const f = fixture(t);
    invalidate(f.world, sit(f.world, 'gpt'));
    assert.equal(hint(f), '');
    sit(f.world, 'claude', 'sofa-4');
    assert.equal(photo(f, 'claude'), '');
    assert.equal(photo(f, 'claude', NOW + 60_000), '');
  });
});

test('waits for the caller and companion to finish movement at four cells/sec plus one second', t => {
  for (const actor of ['gemini', 'gpt']) {
    const f = fixture(t);
    sit(f.world, 'gpt');
    travelling(f.world, actor); // 8 cells: 2000 ms + 1000 ms grace.
    assert.equal(hint(f, 'gemini', { now: NOW - 1 }), '');
    assert.equal(hint(f, 'gemini', { now: NOW + 2999 }), '');
    assert.equal(command(hint(f, 'gemini', { now: NOW + 3000 })).spot, 'sofa-2');
  }
});

test('arrival estimates sum the full 3D path and reject unknown movement timing', t => {
  const f = fixture(t);
  sit(f.world, 'gpt');
  const a = f.world.avatars.gemini;
  const move = travelling(f.world, 'gemini', NOW, [
    { x: a.x - 3, y: a.y - 4, z: a.z },
    { x: a.x, y: a.y, z: a.z },
    { x: a.x, y: a.y, z: a.z + 4 },
    { x: a.x, y: a.y, z: a.z },
  ]); // 13 cells, not endpoint distance: 3250 + 1000 ms.
  assert.equal(hint(f, 'gemini', { now: NOW + 4249 }), '');
  assert.ok(hint(f, 'gemini', { now: NOW + 4250 }));
  for (const bad of [{ moveId: 'unknown', path: move.path }, { moveId: NOW },
    { moveId: NOW, path: [{ x: NaN, y: 4, z: 32 }] }]) {
    f.hints = new CozyChatHints();
    f.world.movements.set('gemini', { ...bad, avatar: a });
    assert.equal(hint(f, 'gemini', { now: NOW + 600_000 }), '');
  }
});

test('expired movement is harmless and a route for a replaced avatar is ignored', t => {
  const f = fixture(t);
  sit(f.world, 'gpt');
  travelling(f.world, 'gpt', NOW - 10_000);
  travelling(f.world, 'gemini');
  f.world.avatars.gemini = structuredClone(f.world.avatars.gemini);
  assert.ok(hint(f));
});

test('busy participants and nonstanding callers receive no seat hint; others remain free', async t => {
  for (const state of [
    { meal: { status: 'cooking', cook: 'gemini', eatenBy: [] } },
    { meal: { status: 'ready', cook: 'gemini', eatenBy: [] } },
    { meal: { status: 'served', cook: 'gpt', eatenBy: ['gemini'] } },
    { game: { status: 'waiting', players: ['gemini'] } },
    { game: { status: 'playing', players: ['gpt', 'gemini'] } },
    { pausedAt: NOW }, { unavailable: true },
  ]) await t.test(JSON.stringify(state), t => {
    const f = fixture(t);
    sit(f.world, 'gpt');
    assert.equal(hint(f, 'gemini', { living: state }), '');
    assert.equal(hint(f, 'gemini', { living: { view: () => state } }), '');
    assert.ok(hint(f), 'a suppressed opportunity was not consumed');
  });
  const f = fixture(t);
  sit(f.world, 'gpt');
  for (const posture of ['work', 'lie', 'sleep', 'sit']) {
    f.world.avatars.gemini.posture = posture;
    assert.equal(hint(f), '');
  }
  f.world.avatars.gemini.posture = 'stand';
  assert.ok(hint(f, 'gemini', { living: {
    meal: { status: 'cooking', cook: 'claude', eatenBy: [] },
    game: { status: 'playing', players: ['gpt', 'deepseek'] },
  } }));
  assert.ok(hint(f, 'claude', { living: {
    meal: { status: 'finished', cook: 'claude' }, game: { status: 'finished', players: ['claude'] },
  } }));
});

test('full sofa and absent home never produce a seat hint', t => {
  const f = fixture(t);
  const standing = structuredClone(f.world.avatars.gemini);
  IDS.forEach((id, i) => sit(f.world, id, `sofa-${i + 1}`));
  f.world.avatars.visitor = standing;
  assert.equal(hint(f, 'visitor'), '');
  f.world.home = null;
  assert.equal(hint(f, 'visitor'), '');
  assert.equal(f.hints.hint(null, 'gemini'), '');
});

test('photo requires sixty seconds of observations and is shared once across seated callers', t => {
  const f = fixture(t);
  sit(f.world, 'gpt'); sit(f.world, 'gemini', 'sofa-4');
  assert.equal(photo(f, 'gpt', NOW + 600_000), '', 'first observation never backdates stability');
  assert.equal(photo(f, 'gemini', NOW + 659_999), '');
  const text = photo(f, 'gpt', NOW + 660_000, { nameOf: id => ({ gpt: '아디나', gemini: '비앙카' })[id] });
  assert.match(text, /아디나, 비앙카.*사진 한 장/);
  assert.match(text, /원하면.*촬영 여부는 자유/);
  assert.doesNotMatch(text, /relax|move|모두|전원|claude|deepseek/);
  assert.equal(photo(f, 'gemini', NOW + 660_001), '');
  assert.equal(photo(f, 'gpt', NOW + 6_000_000), '');
});

test('photo availability and observer turn order do not consume the stable opportunity', t => {
  const f = fixture(t);
  sit(f.world, 'gpt'); sit(f.world, 'gemini', 'sofa-2');
  assert.equal(photo(f, 'gpt', NOW, { photoAvailable: false }), '');
  assert.equal(photo(f, 'gpt', NOW + 60_000, { photoAvailable: false }), '');
  assert.doesNotMatch(photo(f, 'claude', NOW + 60_001), /사진/);
  assert.match(photo(f, 'gemini', NOW + 60_002), /사진/);
  assert.equal(photo(f, 'gpt', NOW + 60_003), '');
});

test('photo never counts an arriving resident and waits anew when another arrives', t => {
  const f = fixture(t);
  sit(f.world, 'gpt'); sit(f.world, 'gemini', 'sofa-2');
  travelling(f.world, 'gemini');
  assert.equal(photo(f), '');
  assert.equal(photo(f, 'gpt', NOW + 2999), '');
  assert.equal(photo(f, 'gpt', NOW + 3000), '');
  assert.equal(photo(f, 'gpt', NOW + 62_999), '');
  assert.match(photo(f, 'gpt', NOW + 63_000), /사진/);
  sit(f.world, 'claude', 'sofa-3');
  travelling(f.world, 'claude', NOW + 64_000);
  assert.equal(photo(f, 'gpt', NOW + 64_000), '');
  assert.equal(photo(f, 'gemini', NOW + 66_999), '');
  assert.equal(photo(f, 'gpt', NOW + 67_000), '');
  assert.equal(photo(f, 'claude', NOW + 126_999), '');
  assert.match(photo(f, 'gemini', NOW + 127_000), /사진/);
  assert.equal(photo(f, 'claude', NOW + 127_001), '');
});

test('photo absence, membership changes and later moves require a fresh stable minute', t => {
  const f = fixture(t), standing = structuredClone(f.world.avatars.gemini);
  sit(f.world, 'gpt'); sit(f.world, 'gemini', 'sofa-2');
  photo(f);
  assert.match(photo(f, 'gpt', NOW + 60_000), /사진/);
  f.world.avatars.gemini = standing;
  assert.equal(photo(f, 'gpt', NOW + 61_000), '');
  sit(f.world, 'gemini', 'sofa-2');
  assert.equal(photo(f, 'gemini', NOW + 62_000), '');
  assert.equal(photo(f, 'gpt', NOW + 121_999), '');
  assert.match(photo(f, 'gpt', NOW + 122_000), /사진/);

  // An entire trip may finish between calls. A changed moveId still resets it.
  travelling(f.world, 'gemini', NOW + 123_000);
  assert.equal(photo(f, 'gpt', NOW + 130_000), '');
  assert.equal(photo(f, 'gpt', NOW + 189_999), '');
  assert.match(photo(f, 'gemini', NOW + 190_000), /사진/);
  sit(f.world, 'deepseek', 'sofa-4');
  assert.equal(photo(f, 'deepseek', NOW + 191_000), '');
  assert.match(photo(f, 'deepseek', NOW + 251_000), /사진/);
});

test('disconnected or invalid sofas cannot create a shared photo cluster', t => {
  const f = fixture(t);
  sit(f.world, 'gpt'); sit(f.world, 'gemini', 'sofa-3');
  f.world.blocks.delete('10,4,33');
  assert.equal(photo(f), '');
  assert.equal(photo(f, 'gpt', NOW + 60_000), '');
  f.world.blocks.set('10,4,33', 'casa_sage/bench/e');
  assert.equal(photo(f, 'gpt', NOW + 61_000), '');
  assert.match(photo(f, 'gpt', NOW + 121_000), /사진/);
});

test('uncertain sofa occupancy resets photos; unrelated distant movement does not', t => {
  const f = fixture(t);
  sit(f.world, 'gpt'); sit(f.world, 'gemini', 'sofa-2');
  photo(f);
  f.world.avatars.visitor = { x: 10, y: 4, z: 34, posture: 'stand' };
  assert.equal(photo(f, 'gpt', NOW + 60_000), '');
  delete f.world.avatars.visitor;
  assert.equal(photo(f, 'gpt', NOW + 61_000), '');
  travelling(f.world, 'deepseek', NOW + 121_000);
  assert.match(photo(f, 'gpt', NOW + 121_000), /사진/);
});

test('clock rollback or invalid time cannot shortcut photo stability', t => {
  const f = fixture(t);
  sit(f.world, 'gpt'); sit(f.world, 'gemini', 'sofa-2');
  photo(f);
  assert.equal(photo(f, 'gpt', NOW - 10_000), '');
  assert.equal(photo(f, 'gpt', NOW + 49_999), '');
  assert.match(photo(f, 'gpt', NOW + 50_000), /사진/);
  assert.equal(photo(f, 'gpt', NaN), '');
  assert.equal(photo(f, 'gpt', NOW + 60_000), '');
  assert.equal(photo(f, 'gpt', NOW + 119_999), '');
});

test('offer memory is private and bounded, and long names keep both outputs below 300 characters', t => {
  const f = fixture(t), standing = structuredClone(f.world.avatars.gemini);
  sit(f.world, 'gpt');
  const occupant = f.world.avatars.gpt;
  for (let i = 0; i < 80; i++) {
    const actor = `guest-${i}`;
    f.world.avatars = { gpt: occupant, [actor]: standing };
    const text = hint(f, actor, { nameOf: () => '🙂 긴 이름\n'.repeat(1000) });
    assert.ok(text.length > 0 && text.length <= 300);
    assert.doesNotMatch(text, /\n/);
    assert.equal(hint(f, actor), '');
  }
  assert.deepEqual(Reflect.ownKeys(f.hints), []);
  for (const i of [16, 79]) {
    f.world.avatars = { gpt: occupant, [`guest-${i}`]: standing };
    assert.equal(hint(f, `guest-${i}`), '', 'the most recent 64 offers remain suppressed');
  }
  f.world.avatars = { gpt: occupant, 'guest-0': standing };
  assert.ok(hint(f, 'guest-0'), 'oldest offers are evicted rather than retained without a bound');
  const giantId = 'x'.repeat(10000);
  f.world.avatars[giantId] = standing;
  assert.equal(hint(f, giantId), '');
  f.world.avatars = { gpt: occupant };
  IDS.slice(1).forEach((id, i) => sit(f.world, id, `sofa-${i + 2}`));
  photo(f);
  const text = photo(f, 'gpt', NOW + 60_000, { nameOf: () => '🙂'.repeat(1000) });
  assert.match(text, /사진/);
  assert.ok(text.length <= 300, `photo has ${text.length} UTF-16 characters`);
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

test('hints mutate no world, living input, options or files and create no timers/actions', t => {
  const f = fixture(t);
  sit(f.world, 'gpt'); sit(f.world, 'claude', 'sofa-3');
  const living = freeze({ meal: null, game: null, pausedAt: null });
  const options = freeze({ living, now: NOW, photoAvailable: true });
  freeze(f.world.home); freeze(f.world.avatars);
  const before = structuredClone({ blocks: [...f.world.blocks], avatars: f.world.avatars,
    home: f.world.home, movements: [...f.world.movements], sequence: f.world.moveSequence, living });
  const saved = fs.readFileSync(f.world.file, 'utf8');
  const files = fs.readdirSync(path.join(f.root, 'data'));
  for (const method of ['useFurniture', 'move', 'save']) t.mock.method(f.world, method, () => {
    assert.fail(`hint must not call world.${method}`);
  });
  const timers = ['setTimeout', 'setInterval'].map(method => t.mock.method(globalThis, method, () => {
    assert.fail(`hint must not call ${method}`);
  }));
  try {
    assert.ok(f.hints.hint(f.world, 'gemini', options));
    assert.equal(f.hints.hint(f.world, 'gpt', options), '');
    assert.match(f.hints.hint(f.world, 'claude', { ...options, now: NOW + 60_000 }), /사진/);
  } finally { timers.forEach(mock => mock.mock.restore()); }
  assert.deepEqual({ blocks: [...f.world.blocks], avatars: f.world.avatars,
    home: f.world.home, movements: [...f.world.movements], sequence: f.world.moveSequence, living }, before);
  assert.equal(fs.readFileSync(f.world.file, 'utf8'), saved);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'data')), files);
  assert.equal(f.world.saveTimer, null);
  assert.equal(options.now, NOW);
});

test('executing suggested relax through applyLivingAction seats only the caller', t => {
  const f = fixture(t);
  const living = new LivingRoom(f.root, { members: IDS, now: () => NOW });
  living.resume(NOW);
  sit(f.world, 'gpt');
  const before = structuredClone(f.world.avatars), blocks = [...f.world.blocks];
  const suggested = command(hint(f, 'gemini', { living }));
  assert.deepEqual(suggested, { op: 'relax', spot: 'sofa-2' });
  assert.equal(f.world.movements.size, 0, 'the hint itself is only text');
  const result = applyLivingAction(living, f.world, 'gemini', suggested, NOW);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.world.avatars.gemini.posture, 'sit');
  assert.deepEqual(f.world.avatars.gemini.furniture.at, [10, 4, 33]);
  for (const id of IDS.filter(id => id !== 'gemini')) assert.deepEqual(f.world.avatars[id], before[id]);
  assert.deepEqual([...f.world.blocks], blocks);
  assert.deepEqual([...f.world.movements.keys()], ['gemini']);
  assert.equal(living.view().meal, null);
  assert.equal(living.view().game, null);
});
