import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../lib/world.mjs';
import { buildHouse } from '../lib/house.mjs';

function fixture(t, saved = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-navigation-'));
  fs.mkdirSync(path.join(home, 'data'));
  fs.writeFileSync(path.join(home, 'data', 'world.json'), JSON.stringify({ avatars: { a: { x: 6, y: 1, z: 6 } }, ...saved }));
  const w = new World(home, ['a']);
  t.after(() => { clearTimeout(w.saveTimer); fs.rmSync(home, { recursive: true, force: true }); });
  return w;
}
function box(w, from, to, block = 'stone') {
  for (let x = from[0]; x <= to[0]; x++) for (let y = from[1]; y <= to[1]; y++) for (let z = from[2]; z <= to[2]; z++) w.blocks.set(`${x},${y},${z}`, block);
}
test('standing up chooses a nearby reachable floor when the old return cell is occupied', t => {
  const w=fixture(t);
  w.blocks.set('8,1,6','planks/chair/n');
  assert.equal(w.useFurniture('a',[8,1,6]).ok,true);
  w.avatars.b={x:6,y:1,z:6,posture:'stand'};
  assert.equal(w.useFurniture('a',null).ok,true);
  assert.equal(w.avatars.a.posture,'stand');
  assert.notDeepEqual([w.avatars.a.x,w.avatars.a.z],[6,6]);
  assert.ok(w.clearAt(w.avatars.a.x,w.avatars.a.z,w.avatars.a.y-1));
});
function walkableRoute(w, route) {
  assert.ok(route.length > 0 && route.length <= 256);
  for (const [i, p] of route.entries()) {
    assert.deepEqual(Object.keys(p).sort(), ['x', 'y', 'z']);
    assert.ok(Object.values(p).every(Number.isFinite));
    assert.ok(w.clearAt(p.x, p.z, p.y - 1), `body is clear at ${JSON.stringify(p)}`);
    assert.equal(w.standingY(p.x, p.z, p.y - 1, w.blocks, 0), p.y - 1, 'each point has floor support');
    if (i) {
      const previous = route[i - 1];
      assert.equal(Math.abs(p.x - previous.x) + Math.abs(p.z - previous.z), 1, 'cardinal neighbours only');
      assert.ok(p.y - previous.y <= 1 && p.y - previous.y >= -2, 'bounded climb/drop');
    }
  }
}

test('U-wall routing goes around the opening instead of crossing walls', (t) => {
  const w = fixture(t, { avatars: { a: { x: 12, y: 1, z: 14 } } });
  box(w, [10, 1, 10], [14, 4, 10]);
  box(w, [10, 1, 10], [10, 4, 16]);
  box(w, [14, 1, 10], [14, 4, 16]);
  assert.equal(w.move('a', [12, 8]), true);
  const a = w.avatarView().a;
  assert.deepEqual([a.x, a.y, a.z], [12, 1, 8], 'destination is authoritative immediately');
  assert.deepEqual(a.path[0], { x: 12, y: 1, z: 14 });
  assert.ok(a.path.some((p) => p.z === 17), 'must leave the U before going north');
  walkableRoute(w, a.path);
});

test('sealed destinations fail without mutation; a two-block doorway is traversable', (t) => {
  const w = fixture(t);
  box(w, [10, 1, 10], [14, 4, 10]); box(w, [10, 1, 14], [14, 4, 14]);
  box(w, [10, 1, 10], [10, 4, 14]); box(w, [14, 1, 10], [14, 4, 14]);
  const before = structuredClone(w.avatars);
  assert.equal(w.move('a', [12, 12]), false);
  assert.deepEqual(w.avatars, before); assert.equal(w.saveTimer, null);
  w.blocks.set('12,1,10', 'door/x'); w.blocks.set('12,2,10', 'door/x');
  assert.equal(w.move('a', [12, 12]), true);
  assert.ok(w.avatarView().a.path.some((p) => p.x === 12 && p.z === 10));
  walkableRoute(w, w.avatarView().a.path);
});

test('floor support, roofs, slabs, stair climbs and bounded drops', (t) => {
  const w = fixture(t);
  box(w, [8, 1, 8], [14, 1, 14]); box(w, [8, 5, 8], [14, 5, 14], 'planks');
  assert.equal(w.move('a', [12, 12]), true);
  assert.equal(w.avatarView().a.y, 2);
  assert.ok(w.avatarView().a.path.every((p) => p.y <= 2));
  w.blocks.set('15,1,12', 'stone/slab');
  assert.equal(w.move('a', [15, 12]), true); assert.equal(w.avatarView().a.y, 1.5);
  box(w, [20, 1, 10], [22, 5, 12]);
  assert.equal(w.move('a', [21, 11]), false, 'no jump onto a tall roof');
  const cliff = fixture(t, { blocks: { '10,4,10': 'stone' }, avatars: { a: { x: 10, y: 5, z: 10 } } });
  assert.equal(cliff.move('a', [11, 10]), false, 'no four-block fall to ground');
  cliff.blocks.set('11,2,10', 'stone');
  assert.equal(cliff.move('a', [11, 10]), true, 'two-block supported drop');
  walkableRoute(cliff, cliff.avatarView().a.path);
  const stairs = fixture(t);
  box(stairs, [10, 1, 6], [12, 3, 6]);
  stairs.blocks.set('8,1,6', 'stone/stair/e');
  box(stairs, [9, 1, 6], [9, 2, 6]);
  assert.equal(stairs.move('a', [12, 6]), true);
  assert.equal(stairs.avatarView().a.y, 4);
  walkableRoute(stairs, stairs.avatarView().a.path);
});

test('a low lintel cannot be crossed by stepping up underneath it', (t) => {
  const w = fixture(t, { avatars: { a: { x: 1, y: 1, z: 1 } } });
  box(w, [0, 1, 0], [0, 4, 3]); box(w, [2, 1, 0], [2, 4, 3]);
  box(w, [0, 1, 0], [2, 4, 0]);
  w.blocks.set('1,3,1', 'stone'); w.blocks.set('1,1,2', 'stone');
  assert.equal(w.move('a', [1, 3]), false);
});

test('movement tokens and cloned routes are stable across repeated SSE views', (t) => {
  const w = fixture(t);
  assert.equal(w.move('a', [10, 8]), true);
  const first = w.avatarView().a, second = w.avatarView().a;
  assert.ok(Number.isSafeInteger(first.moveId)); assert.deepEqual(first, second);
  first.path[0].x = -100;
  assert.deepEqual(w.avatarView().a, second, 'view consumers cannot mutate the stored route');
  assert.equal(w.move('a', [10, 8]), true);
  assert.equal(w.avatarView().a.moveId, second.moveId, 'same destination does not replay movement');
  assert.equal(w.move('a', [11, 8]), true);
  assert.ok(w.avatarView().a.moveId > second.moveId);
  assert.deepEqual(w.avatarView().a.path[0], { x: 10, y: 1, z: 8 });
});

test('standing avatars are passable in a hallway, but endpoints remain occupied', (t) => {
  const w = fixture(t, { avatars: { a: { x: 1, y: 1, z: 1 }, b: { x: 4, y: 1, z: 1 } } });
  box(w, [0, 1, 0], [10, 4, 0]); box(w, [0, 1, 2], [10, 4, 2]);
  assert.equal(w.move('a', [7, 1]), true);
  assert.ok(w.avatarView().a.path.some((p) => p.x === 4));
  assert.equal(w.move('b', [7, 1]), false);
  assert.equal(w.move('b', [1, 1]), true, 'previous routes never reserve hallway cells');
});

test('furniture routes reach an approach, finish at the surface, and release occupancy', (t) => {
  const w = fixture(t);
  box(w, [10, 1, 4], [10, 4, 14]);
  w.blocks.set('12,1,8', 'planks/chair/n');
  const result = w.useFurniture('a', [12, 1, 8]);
  assert.equal(result.ok, true);
  const route = result.avatar.path;
  assert.ok(route.some((p) => p.z < 4 || p.z > 14), 'approach routes around the wall');
  walkableRoute(w, route.slice(0, -1));
  assert.deepEqual(route.at(-1), { x: 12, y: 1.46, z: 8 });
  const approach = route.at(-2);
  assert.equal(Math.abs(approach.x - 12) + Math.abs(approach.z - 8), 1);
  assert.deepEqual(w.useFurniture('a', [12, 1, 8]).avatar, result.avatar, 'repeat use does not replay');
  assert.equal(w.move('a', [13, 8]), true);
  assert.equal(w.avatarView().a.furniture, undefined);
  assert.deepEqual(w.avatarView().a.path[0], route.at(-1));
  assert.equal(w.move('b', [14, 8]), true, 'unknown avatars retain the legacy registration API');
  assert.equal(w.useFurniture('b', [12, 1, 8]).ok, true);
  w.blocks.set('14,1,12', 'planks/workbench/n');
  const work = w.useFurniture('a', [14, 1, 12]);
  assert.equal(work.ok, true); assert.equal(work.avatar.posture, 'work');
  assert.deepEqual(work.avatar.path.at(-1), { x: 14, y: 1, z: 11 });
  walkableRoute(w, work.avatar.path);
});

test('unreachable furniture and blocked seat exits keep state and occupancy', (t) => {
  const w = fixture(t);
  w.blocks.set('12,1,12', 'planks/chair/n');
  box(w, [10, 1, 10], [14, 4, 10]); box(w, [10, 1, 14], [14, 4, 14]);
  box(w, [10, 1, 10], [10, 4, 14]); box(w, [14, 1, 10], [14, 4, 14]);
  const before = structuredClone(w.avatars);
  assert.deepEqual(w.useFurniture('a', [12, 1, 12]), { ok: false, error: 'unreachable' });
  assert.deepEqual(w.avatars, before);
  w.blocks.set('12,1,10', 'door/x'); w.blocks.set('12,2,10', 'door/x');
  assert.equal(w.useFurniture('a', [12, 1, 12]).ok, true);
  const seated = w.avatarView();
  w.blocks.set('12,1,10', 'stone'); w.blocks.set('12,2,10', 'stone');
  for (const [x,z] of [[11,12],[13,12],[12,11],[12,13]]) box(w,[x,1,z],[x,4,z]);
  assert.deepEqual(w.useFurniture('a', null), { ok: false, error: 'unreachable' });
  assert.equal(w.move('a', [6, 6]), false);
  assert.deepEqual(w.avatarView(), seated);
});

test('excessively long mazes fail within the bounded route budget', (t) => {
  const w = fixture(t, { avatars: { a: { x: 1, y: 1, z: 1 } } });
  for (let z = 2; z <= 44; z += 2) box(w, [z % 4 === 2 ? 0 : 1, 1, z], [z % 4 === 2 ? 46 : 47, 3, z]);
  const before = structuredClone(w.avatars);
  assert.equal(w.move('a', [1, 45]), false);
  assert.deepEqual(w.avatars, before);
});

test('house metadata roundtrips both save paths, excludes secrets, and routes never persist', async (t) => {
  const home = { id: 'mulgyeol-maru', title: '물결마루', floorY: 3,
    rooms: [{ id: 'living', title: '거실', bounds: [8, 8, 18, 18], center: [13, 4, 13] }],
    cameras: [{ id: 'living', label: '거실', target: { x: 13, y: 4, z: 13 }, angle: 45, elev: 30, dist: 20 }],
    furniture: [{ id: 'chair', at: [12, 4, 12], shape: 'chair', facing: 'n' }],
    spawns: [{ x: 8, y: 4, z: 10 }] };
  const w = fixture(t, { home: { ...home, apiKey: 'secret-top', provider: { token: 'secret-config' },
    rooms: [{ ...home.rooms[0], credential: 'secret-room' }], cameras: [{ ...home.cameras[0], provider: 'secret-camera' }] } });
  assert.deepEqual(w.view().home, home);
  const view = w.view(); view.home.rooms[0].center[0] = 999;
  assert.deepEqual(w.view().home, home);
  assert.match(w.summary('a', () => '비앙카'), /물결마루: 거실 \(13,4,13\)/);
  assert.doesNotMatch(JSON.stringify(w.view()), /secret-/);
  w.move('a', [8, 6]);
  await new Promise((resolve) => setTimeout(resolve, 450));
  let saved = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.deepEqual(saved.home, home); assert.equal(saved.avatars.a.path, undefined); assert.equal(saved.avatars.a.moveId, undefined);
  w.applyCells([[20, 1, 20, 'stone']], 'a');
  saved = JSON.parse(fs.readFileSync(w.file, 'utf8')); assert.deepEqual(saved.home, home);
  saved.avatars.a.path = [{ x: -1, y: 99, z: -1 }]; saved.avatars.a.moveId = 999;
  fs.writeFileSync(w.file, JSON.stringify(saved));
  const loaded = new World(path.dirname(path.dirname(w.file)), ['a']);
  assert.deepEqual(loaded.view().home, home);
  assert.equal(loaded.avatarView().a.path, undefined); assert.equal(loaded.avatarView().a.moveId, undefined);
});

test('a failed delayed save preserves the last snapshot and can retry atomically', async (t) => {
  const w = fixture(t), original = fs.readFileSync(w.file, 'utf8');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('simulated disk write failure'); });
  w.move('a', [8, 6]);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.match(w.saveError.message, /simulated/);
  assert.equal(fs.readFileSync(w.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(w.file)), ['world.json']);
  rename.mock.restore(); w.save();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(w.saveError, null);
  assert.equal(JSON.parse(fs.readFileSync(w.file, 'utf8')).avatars.a.x, 8);
});

test('shutdown flush saves pending movement and reports failure without replacing the original', t => {
  const w = fixture(t), original = fs.readFileSync(w.file, 'utf8');
  w.move('a', [8, 6]); assert.ok(w.saveTimer);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('disk unavailable'); });
  assert.throws(() => w.flush(), /disk unavailable/);
  assert.equal(fs.readFileSync(w.file, 'utf8'), original);
  rename.mock.restore(); w.flush();
  assert.equal(w.saveTimer, null); assert.equal(w.saveError, null);
  assert.equal(JSON.parse(fs.readFileSync(w.file, 'utf8')).avatars.a.x, 8);
});

test('a corrupt saved world fails closed instead of becoming an empty replacement', t => {
  const w = fixture(t); fs.writeFileSync(w.file, '{broken');
  assert.throws(() => new World(path.dirname(path.dirname(w.file)), ['a']));
  assert.equal(fs.readFileSync(w.file, 'utf8'), '{broken');
});

test('unknown/prototype avatar validation preserves existing semantics', (t) => {
  const w = fixture(t);
  assert.deepEqual(w.useFurniture('missing', [1, 1, 1]), { ok: false, error: 'unknown_avatar' });
  for (const id of ['__proto__', 'constructor', 'prototype']) assert.equal(w.move(id, [1, 1]), false);
  assert.equal(w.move('new-member', [3, 4]), true);
  assert.deepEqual(w.avatarView()['new-member'].path, [{ x: 3, y: 1, z: 4 }]);
  assert.equal(w.move('another-new-member', [3, 4]), true, 'registration retains legacy spawn semantics');
});

test('approved house metadata stays intact and every furnished location is navigable from outside', (t) => {
  const source = buildHouse(), w = fixture(t, source);
  assert.deepEqual(w.view().home, source.home, 'camera cutaways, rooms, landmarks and spawn metadata survive sanitizing');
  assert.equal(w.move('a', [21, 41]), true);
  assert.equal(w.move('a', [21, 37]), true);
  assert.equal(w.avatarView().a.y, 4);
  walkableRoute(w, w.avatarView().a.path);
  for (const [id, furniture] of Object.entries(source.home.furniture)) {
    const result = w.useFurniture('a', furniture.at);
    assert.equal(result.ok, true, `${id}: ${result.error}`);
    assert.ok(result.avatar.path.length <= 256);
    assert.ok(result.avatar.path.every((p) => p.y >= 4 && p.y < 5), `${id}: route stays on the indoor storey`);
    assert.equal(w.useFurniture('a', null).ok, true, `${id}: can return via the doorway`);
  }
  w.applyCells([], 'a');
  assert.deepEqual(JSON.parse(fs.readFileSync(w.file, 'utf8')).home, source.home);
  assert.match(w.summary('a', () => '방문자'), /물결마루 현관 \(21,4,37\)/);
});

test('all four original spawns reach every bedroom and all 45 published furniture approaches', (t) => {
  const source = buildHouse(), w = fixture(t, source);
  const bedrooms = source.home.rooms.filter((room) => room.kind === 'bedroom');
  assert.equal(bedrooms.length, 4);
  assert.equal(Object.keys(source.home.furniture).length, 45);
  assert.equal(Object.keys(source.home.spawns).length, 4);
  assert.equal(source.home.cameras.length, 3);
  const targets = [
    ...bedrooms.map((room) => [room.id, [Math.floor((room.rectXZ[0] + room.rectXZ[2]) / 2), 4, room.rectXZ[3] - 1]]),
    ...Object.entries(source.home.furniture).map(([id, furniture]) => [id, furniture.approach]),
  ];
  for (const [member, spawn] of Object.entries(source.avatars)) for (const [targetId, [x, y, z]] of targets) {
    w.avatars = structuredClone(source.avatars);
    w.movements.clear();
    assert.equal(w.move(member, [x, z]), true, `${member} from its original spawn -> ${targetId}`);
    const avatar = w.avatarView()[member];
    assert.deepEqual(avatar.path[0], { x: spawn.x, y: spawn.y, z: spawn.z });
    assert.deepEqual(avatar.path.at(-1), { x, y, z });
    assert.ok(avatar.path.every((p) => p.y === 4), `${targetId}: no ground shortcuts or roof jumps`);
    walkableRoute(w, avatar.path);
  }
});
