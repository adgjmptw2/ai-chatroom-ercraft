import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHouse, HOUSE_VERSION, ROOM_ASSIGNMENTS } from '../lib/house.mjs';
import { World, SIZE, PALETTE, SHAPES, parseBlock } from '../lib/world.mjs';
import { FURNITURE, FACING_VECTOR } from '../public/world-materials.js';

function loaded(t) {
  const fixture = buildHouse();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-house-test-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'world.json'), JSON.stringify(fixture));
  const world = new World(root, Object.keys(ROOM_ASSIGNMENTS));
  t.after(() => {
    clearTimeout(world.saveTimer);
    // Remove only this test's freshly allocated, verified temporary directory.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('chatroom-house-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { fixture, world };
}

const inRect = (x, z, [x0, z0, x1, z1]) => x >= x0 && x < x1 && z >= z0 && z < z1;
function cells(rect) {
  const out = [];
  for (let x = rect[0]; x < rect[2]; x++) for (let z = rect[1]; z < rect[3]; z++) out.push([x, z]);
  return out;
}
function reachableFloor(world, start = [21, 37]) {
  const seen = new Set([start.join(',')]), queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const [x, z] = queue[head];
    for (const [dx, dz] of Object.values(FACING_VECTOR)) {
      const nx = x + dx, nz = z + dz, key = `${nx},${nz}`;
      if (seen.has(key) || !inRect(nx, nz, [9, 9, 38, 38])) continue;
      // Fixed feet height prevents a test from quietly walking on a roof.
      if (world.standingY(nx, nz, 3, world.blocks, 0) !== 3 || !world.clearAt(nx, nz, 3)) continue;
      seen.add(key); queue.push([nx, nz]);
    }
  }
  return seen;
}

test('versioned fixture is deterministic, independently owned and within the low-load budgets', () => {
  const a = buildHouse(), b = buildHouse();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.equal(a.home.fixtureVersion, HOUSE_VERSION);
  assert.equal(a.home.schemaVersion, 1);
  assert.equal(a.home.id, 'mulgyeol-maru');
  assert.equal(a.home.title, '물결마루');
  assert.deepEqual(a.home.rectXZ, [9, 9, 38, 38]);
  assert.deepEqual(a.home.bounds, [9, 9, 38, 38]);
  assert.ok(Object.keys(a.blocks).length < 6000);
  assert.ok(Object.keys(a.custom).length <= 40);
  assert.ok(Object.keys(a.signs).length <= 12);
  assert.equal(Object.values(a.blocks).filter((v) => v === 'lamp').length, 4);
  assert.equal(Object.values(a.custom).filter((v) => v.glow).length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(a)) < 250_000);
  a.home.rooms[0].rectXZ[0] = -99;
  a.custom.casa_cream.pixels[0] = 'bbbbbbbb';
  a.blocks['0,1,0'] = 'stone';
  assert.deepEqual(buildHouse(), b, 'a caller cannot alter later fixture builds');
});

test('every stored cell, custom tile and sign satisfies the existing World format', (t) => {
  const { fixture, world } = loaded(t);
  assert.deepEqual(Object.fromEntries(world.blocks), fixture.blocks);
  assert.deepEqual(world.custom, fixture.custom);
  assert.deepEqual(world.signs, fixture.signs);
  assert.deepEqual(world.avatarView(), fixture.avatars);
  for (const [key, value] of Object.entries(fixture.blocks)) {
    const [x, y, z] = key.split(',').map(Number);
    assert.ok([x, y, z].every(Number.isSafeInteger));
    assert.ok(x >= 0 && x < SIZE.x && y >= 1 && y < SIZE.y && z >= 0 && z < SIZE.z, key);
    const { type, shape, facing } = parseBlock(value);
    assert.ok(PALETTE[type] || fixture.custom[type], value);
    assert.ok(['full', 'door', ...SHAPES].includes(shape), value);
    if (shape === 'door') assert.ok(['x', 'z'].includes(facing));
    else if (shape !== 'full' && shape !== 'slab') assert.ok(Object.hasOwn(FACING_VECTOR, facing));
  }
  for (const [name, tile] of Object.entries(fixture.custom)) {
    assert.match(name, /^[a-z][a-z0-9_]{1,19}$/);
    assert.ok(!Object.hasOwn(PALETTE, name));
    assert.ok(Object.keys(tile.colors).length >= 1 && Object.keys(tile.colors).length <= 12);
    assert.equal(tile.pixels.length, 8);
    for (const row of tile.pixels) {
      assert.equal([...row].length, 8);
      for (const ch of row) assert.ok(tile.colors[ch]);
    }
    for (const color of Object.values(tile.colors)) assert.match(color, /^#[0-9a-f]{6}$/);
  }
  for (const [key, sign] of Object.entries(fixture.signs)) {
    assert.ok([...sign.text].length <= 24, key);
    assert.ok(Object.hasOwn(FACING_VECTOR, sign.facing));
    assert.ok(sign.width >= 1 && sign.width <= 6);
    assert.match(sign.bg, /^#[0-9a-f]{6}$/);
    assert.match(sign.color, /^#[0-9a-f]{6}$/);
  }
});

test('public home/signs/material metadata uses resident names without exposing provider IDs', () => {
  const f = buildHouse();
  assert.doesNotMatch(JSON.stringify([f.home, f.signs, f.custom, f.log]), /gpt|gemini|claude|deepseek|openai|anthropic/i);
  assert.deepEqual(ROOM_ASSIGNMENTS, { gpt: 'adina', gemini: 'bianca', claude: 'eleven', deepseek: 'lucia' });
  const bedrooms = f.home.rooms.filter((r) => r.kind === 'bedroom');
  assert.deepEqual(bedrooms.map((r) => [r.name, r.rectXZ]), [
    ['아디나', [10, 10, 16, 16]], ['비앙카', [17, 10, 23, 16]],
    ['일레븐', [24, 10, 30, 16]], ['루치아', [31, 10, 37, 16]],
  ]);
  for (const [memberId, roomId] of Object.entries(ROOM_ASSIGNMENTS)) {
    const r = bedrooms.find((r) => r.id === roomId), spawn = f.avatars[memberId];
    assert.ok(inRect(spawn.x, spawn.z, [10, 30, 37, 37]));
    assert.equal(spawn.y, 4);
    assert.equal(f.home.spawns[roomId].name, r.name);
    assert.ok(Object.values(f.signs).some((s) => s.text === r.name));
  }
});

test('all four bedroom entrances, bath, album and common rooms connect to every common-room spawn at floor 3', (t) => {
  const { fixture, world } = loaded(t), reachable = reachableFloor(world);
  for (const room of fixture.home.rooms) {
    assert.ok(cells(room.rectXZ).some(([x, z]) => reachable.has(`${x},${z}`)), room.name);
    for (const entrance of room.entrances || []) for (const [x, z] of cells(entrance.rectXZ)) {
      assert.ok(reachable.has(`${x},${z}`), `${entrance.name}: ${x},${z}`);
      assert.equal(world.standingY(x, z, 3, world.blocks, 0), 3);
    }
  }
  for (const spawn of Object.values(fixture.avatars)) assert.ok(reachable.has(`${spawn.x},${spawn.z}`));
  for (const spawn of Object.values(fixture.avatars)) {
    const fromSpawn = reachableFloor(world, [spawn.x, spawn.z]);
    for (const room of fixture.home.rooms.filter((r) => r.kind === 'bedroom'))
      for (const [x, z] of cells(room.entrances[0].rectXZ)) assert.ok(fromSpawn.has(`${x},${z}`), `${room.id} unreachable from spawn`);
    for (const f of Object.values(fixture.home.furniture)) assert.ok(fromSpawn.has(`${f.approach[0]},${f.approach[2]}`), `${f.name} unreachable from spawn`);
  }
  for (const route of fixture.home.routes) {
    assert.ok(Math.min(route.rectXZ[2] - route.rectXZ[0], route.rectXZ[3] - route.rectXZ[1]) >= 3);
    for (const [x, z] of cells(route.rectXZ)) {
      assert.ok(reachable.has(`${x},${z}`), `${route.id}: blocked route ${x},${z}`);
      for (const y of [4, 5, 6]) assert.equal(fixture.blocks[`${x},${y},${z}`], undefined, `${route.id}: obstructed headroom`);
    }
  }
});

test('both three-wide entrance stairs continuously connect ground and house in both directions', (t) => {
  const { fixture, world } = loaded(t);
  for (const entrance of fixture.home.entrances) {
    assert.equal(entrance.width, 3);
    for (const direction of [1, -1]) {
      const center = direction === 1 ? entrance.stairRoute : [...entrance.stairRoute].reverse();
      for (const offset of [-1, 0, 1]) {
        let previous;
        for (const [cx, feet, cz] of center) {
          const x = cx + (entrance.id === 'front' ? offset : 0);
          const z = cz + (entrance.id === 'garden' ? offset : 0);
          if (previous) assert.equal(Math.abs(x - previous[0]) + Math.abs(z - previous[2]), 1);
          assert.equal(world.standingY(x, z, previous?.[1] ?? feet), feet, `${entrance.id}: ${x},${feet},${z}`);
          assert.ok(world.clearAt(x, z, feet));
          previous = [x, feet, z];
        }
      }
    }
  }
});

test('every named furniture anchor has a supported clear pose and a reachable approach', (t) => {
  const { fixture, world } = loaded(t), reachable = reachableFloor(world);
  const furnitureBlocks = Object.entries(fixture.blocks).filter(([, value]) => Object.hasOwn(FURNITURE, parseBlock(value).shape));
  assert.equal(furnitureBlocks.length, Object.keys(fixture.home.furniture).length);
  const seen = new Set();
  for (const [id, f] of Object.entries(fixture.home.furniture)) {
    assert.ok(f.at.every(Number.isSafeInteger), id);
    assert.equal(f.at[1], 4);
    assert.ok(!seen.has(f.at.join(',')), id); seen.add(f.at.join(','));
    const pose = world.furniturePose(f.at);
    assert.equal(pose.error, undefined, `${id}: ${pose.error}`);
    assert.equal(pose.shape, f.shape);
    assert.equal(pose.posture, FURNITURE[f.shape].posture);
    // Seats may face a table (dining chairs); require an accessible adjacent
    // transfer cell. Work surfaces must have their actual front cell free.
    const [x, , z] = f.at;
    assert.ok(Object.values(FACING_VECTOR).some(([dx, dz]) => reachable.has(`${x + dx},${z + dz}`)), `${id}: isolated`);
    assert.ok(reachable.has(`${f.approach[0]},${f.approach[2]}`), `${id}: inaccessible named approach`);
    if (pose.posture === 'work') {
      assert.ok(reachable.has(`${pose.x},${pose.z}`), `${id}: blocked work position`);
      assert.deepEqual([pose.x, pose.y, pose.z], f.approach);
    }
  }
  assert.deepEqual(new Set(furnitureBlocks.map(([, v]) => parseBlock(v).shape)), new Set(['chair', 'bench', 'bed', 'workbench', 'table']));
  assert.equal(furnitureBlocks.filter(([, v]) => parseBlock(v).shape === 'bed').length, 4);
});

test('four residents can use their beds simultaneously and return indoors without reset', (t) => {
  const { fixture, world } = loaded(t);
  for (const [memberId, roomId] of Object.entries(ROOM_ASSIGNMENTS)) {
    assert.equal(world.useFurniture(memberId, fixture.home.furniture[`${roomId}-bed`].at).ok, true);
    assert.equal(world.avatarView()[memberId].posture, 'lie');
  }
  for (const memberId of Object.keys(ROOM_ASSIGNMENTS)) {
    assert.equal(world.useFurniture(memberId, null).ok, true);
    const avatar = world.avatarView()[memberId];
    assert.deepEqual(Object.fromEntries(['x', 'y', 'z', 'posture', 'facing'].map((key) => [key, avatar[key]])), fixture.avatars[memberId]);
    assert.equal(avatar.furniture, undefined);
  }
  // The source generator did not replace the World instance while in use.
  assert.deepEqual(Object.fromEntries(world.blocks), fixture.blocks);
});

test('World useFurniture reaches every furniture item from each original spawn', (t) => {
  const { fixture, world } = loaded(t);
  for (const memberId of Object.keys(ROOM_ASSIGNMENTS)) {
    for (const [id, f] of Object.entries(fixture.home.furniture)) {
      world.avatars = structuredClone(fixture.avatars);
      world.movements?.clear();
      const result = world.useFurniture(memberId, f.at);
      assert.equal(result.ok, true, `${memberId} -> ${id}: ${result.error}`);
      assert.equal(result.avatar.posture, FURNITURE[f.shape].posture);
    }
  }
});

test('courtyard stays open to the sky; roof selectors and cameras remain consistent', () => {
  const { home, blocks } = buildHouse();
  for (const [x, z] of cells([18, 20, 29, 26])) for (const y of [8, 9])
    assert.equal(blocks[`${x},${y},${z}`], undefined, `courtyard roof ${x},${y},${z}`);
  const groups = [...home.cutaway.roofGroups, ...home.cutaway.wallGroups];
  const ids = new Set(groups.map((g) => g.id));
  assert.equal(ids.size, groups.length);
  for (const group of groups) assert.ok(cells(group.rectXZ).some(([x, z]) =>
    Array.from({ length: group.y[1] - group.y[0] }, (_, i) => group.y[0] + i).some((y) => blocks[`${x},${y},${z}`])));
  for (const camera of home.cameras) {
    assert.equal(camera.position.length, 3); assert.equal(camera.target.length, 3);
    assert.ok(camera.horizontalSpan > 0);
    for (const id of camera.hideGroups) assert.ok(ids.has(id), id);
  }
  assert.ok(!home.cameras.find((c) => c.id === 'courtyard').hideGroups.includes('bedroom-roof'));
  assert.equal(home.photoWall.displaySlots.length, 6);
  for (const { at } of home.photoWall.displaySlots) assert.equal(blocks[at.join(',')], 'casa_album');
  for (const [key, block] of Object.entries(blocks)) if (block === 'water') {
    const [x, , z] = key.split(',').map(Number);
    assert.ok(home.waterRegions.some((r) => inRect(x, z, r)));
  }
  for (const key of Object.keys(blocks)) {
    const [x, y, z] = key.split(',').map(Number);
    if (y >= 8) assert.ok(inRect(x, z, home.bounds), 'simple bounds-based cutaway covers every roof cell');
  }
});
