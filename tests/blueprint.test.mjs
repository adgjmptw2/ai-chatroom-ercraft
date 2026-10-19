import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileRecipe, validateCompiled, RECIPE_GUIDE } from '../lib/blueprint.mjs';
import { World, PALETTE, parseBlock } from '../lib/world.mjs';

const recipe = (overrides = {}) => ({
  kind: 'house', origin: [12, 12], size: [9, 9], wallHeight: 4, front: 's',
  materials: { foundation: 'stone', wall: 'white', trim: 'log', floor: 'planks', roof: 'black', window: 'glass', accent: 'purple' },
  roof: { type: 'gable', ridge: 'z', overhang: 1 },
  windows: { spacing: 3, height: 2, sill: 1 }, features: [], ...overrides,
});
const cellsOf = (c) => c.stages.flatMap((s) => s.cells);
const key = (c) => c.slice(0, 3).join(',');
const mapOf = (cells) => new Map(cells.map((c) => [key(c), c]));
const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function connectedToGround(cells) {
  const map = mapOf(cells);
  const queue = cells.filter((c) => c[1] === 1);
  const seen = new Set(queue.map(key));
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    for (const delta of directions) {
      const k = delta.map((v, j) => c[j] + v).join(',');
      if (!seen.has(k) && map.has(k)) { seen.add(k); queue.push(map.get(k)); }
    }
  }
  assert.equal(seen.size, map.size, `floating cluster: ${cells.filter((c) => !seen.has(key(c))).slice(0, 4).map(key).join(';')}`);
}
function assertGeometry(compiled) {
  assert.equal(compiled.stages.length, 4);
  const cells = cellsOf(compiled);
  const map = mapOf(cells);
  assert.equal(compiled.count, cells.length);
  assert.equal(map.size, cells.length, 'stages may never overwrite another stage');
  assert.ok(cells.length <= 2000);
  const accumulated = [];
  for (const stage of compiled.stages) {
    assert.ok(stage.cells.length > 0 && stage.cells.length <= 600);
    accumulated.push(...stage.cells);
    connectedToGround(accumulated);
  }
  const [xa, ya, za, xb, yb, zb] = compiled.bbox;
  assert.ok(xb - xa < 14 && zb - za < 14);
  for (const [x, y, z, block] of cells) {
    assert.ok([x, y, z].every(Number.isSafeInteger));
    assert.ok(x >= xa && x <= xb && y >= ya && y <= yb && z >= za && z <= zb);
    assert.ok(x >= 0 && x < 48 && z >= 0 && z < 48 && y >= 1 && y < 32);
    assert.ok(Object.hasOwn(PALETTE, parseBlock(block).type));
  }
}
function assertEntrance(compiled) {
  const r = compiled.recipe, cells = cellsOf(compiled), map = mapOf(cells);
  const [x, z] = r.origin, [w, d] = r.size;
  const alongX = ['n', 's'].includes(r.front);
  const length = alongX ? w : d;
  const expected = new Set([Math.floor((length - 1) / 2), Math.ceil((length - 1) / 2)]);
  const outward = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[r.front];
  for (const a of expected) {
    const px = alongX ? x + a : r.front === 'e' ? x + w - 1 : x;
    const pz = alongX ? r.front === 's' ? z + d - 1 : z : z + a;
    for (const y of [2, 3]) {
      assert.equal(map.get(`${px},${y},${pz}`)?.[3], r.kind === 'pavilion' ? undefined : `door/${alongX ? 'x' : 'z'}`);
      // The entire approach and the path into the room remain clear at head
      // and body height, even with an optional porch and interior furniture.
      for (let distance = -2; distance <= (r.features.some((f) => f.type === 'porch') ? 3 : 1); distance++) {
        if (distance === 0) continue;
        assert.equal(map.get(`${px + outward[0] * distance},${y},${pz + outward[1] * distance}`), undefined, 'blocked doorway approach');
      }
    }
    assert.ok(map.has(`${px + outward[0]},1,${pz + outward[1]}`), 'front step missing');
  }
  const doors = cells.filter((c) => c[3].startsWith('door/'));
  assert.equal(doors.length, r.kind === 'pavilion' ? 0 : expected.size * 2);
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-test-'));
  fs.mkdirSync(path.join(home, 'data'));
  const world = new World(home, ['fixture-a', 'fixture-b']);
  t.after(() => {
    clearTimeout(world.saveTimer);
    // home is the exact mkdtemp fixture; no live directory is ever used.
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, world };
}

test('guide is self-contained, and compilation is pure, deterministic and bounded', () => {
  assert.match(RECIPE_GUIDE, /single|storey/i);
  assert.match(RECIPE_GUIDE, /600/);
  assert.match(RECIPE_GUIDE, /2000/);
  const raw = recipe();
  const before = structuredClone(raw);
  const compiled = compileRecipe(raw, { site: [11, 11, 24, 24] });
  assert.deepEqual(raw, before);
  assert.deepEqual(compiled, compileRecipe(before, { site: [11, 11, 24, 24] }));
  assert.deepEqual(compiled.bbox.slice(0, 3), [11, 1, 11]);
  assert.deepEqual([compiled.bbox[3], compiled.bbox[5]], [24, 24]);
  assert.equal(validateCompiled(JSON.parse(JSON.stringify(compiled))), true);
  raw.materials.wall = 'brick';
  raw.origin[0] = 2;
  assert.deepEqual(compiled.recipe, before);
  assertGeometry(compiled);
});

test('all kinds, roof profiles, facings and dimension extremes have grounded stages and walkable entrances', () => {
  for (const kind of ['house', 'pavilion', 'workshop', 'chapel'])
    for (const front of ['n', 'e', 's', 'w'])
      for (const [type, ridge] of [['gable', 'x'], ['gable', 'z'], ['hip', 'x'], ['flat', 'x']])
        for (const overhang of [0, 1])
          for (const size of [[7, 7], [8, 10], [11, 11]]) {
            const c = compileRecipe(recipe({ kind, front, size, roof: { type, ridge, overhang } }));
            assertGeometry(c);
            assertEntrance(c);
          }
});

test('all window combinations preserve shared sill/head heights, corner posts and top beams', () => {
  for (const wallHeight of [3, 4, 5]) for (const sill of [1, 2]) for (const height of [1, 2]) for (const spacing of [2, 3, 4]) {
    const raw = recipe({ wallHeight, windows: { sill, height, spacing } });
    if (sill + height > wallHeight - 1) {
      assert.throws(() => compileRecipe(raw), /top beam/);
      continue;
    }
    const compiled = compileRecipe(raw), cells = cellsOf(compiled);
    const windows = cells.filter((c) => c[3] === 'glass');
    assert.ok(windows.length > 0);
    const groups = new Map();
    for (const [x, y, z] of windows) {
      const k = `${x},${z}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(y);
      assert.ok(y < wallHeight + 1);
      assert.ok(!([12, 20].includes(x) && [12, 20].includes(z)));
    }
    for (const ys of groups.values()) assert.deepEqual(ys.sort((a, b) => a - b), Array.from({ length: height }, (_, i) => 2 + sill + i));
    const map = mapOf(cells);
    for (let a = 12; a <= 20; a++) for (const [x, z] of [[12, a], [20, a], [a, 12], [a, 20]]) {
      assert.equal(map.get(`${x},${wallHeight + 1},${z}`)[3], 'log');
    }
    // Side and back facades use mirrored window axes.
    for (const c of windows.filter((c) => c[2] === 12)) assert.equal(map.get(`${32 - c[0]},${c[1]},12`)[3], 'glass');
  }
});

test('gable and hip outer roof stairs face uphill, with a face-connected underside', () => {
  for (const [type, ridge] of [['gable', 'x'], ['gable', 'z'], ['hip', 'x']]) for (const overhang of [0, 1]) {
    const r = recipe({ roof: { type, ridge, overhang } });
    const c = compileRecipe(r), roof = c.stages[2].cells;
    const xa = 12 - overhang, xb = 20 + overhang, za = xa, zb = xb;
    const outer = roof.filter(([x, , z, b]) => b.includes('/stair/') && (x === xa || x === xb || z === za || z === zb));
    assert.ok(outer.length > 0);
    for (const [x, , z, b] of outer) {
      const f = b.split('/')[2];
      if (type === 'gable') assert.equal(f, ridge === 'z' ? x < 16 ? 'e' : 'w' : z < 16 ? 's' : 'n');
      else assert.ok(x === xa && f === 'e' || x === xb && f === 'w' || z === za && f === 's' || z === zb && f === 'n');
    }
    connectedToGround(cellsOf(c));
  }
});

test('features fit inside the reserved bbox, remain grounded, and protect the door and fountain air', () => {
  for (const front of ['n', 'e', 's', 'w']) for (const other of ['garden', 'fountain', 'lamp_posts']) {
    const side = { n: 'e', e: 's', s: 'w', w: 'n' }[front];
    const c = compileRecipe(recipe({ size: [7, 7], features: [{ type: 'porch', side: front, size: 3 }, { type: other, side, size: 3 }], front }));
    assertGeometry(c);
    assertEntrance(c);
    if (other === 'fountain') {
      const water = cellsOf(c).filter((cell) => cell[3] === 'water');
      assert.equal(water.length, 1);
      const [x, y, z] = water[0], map = mapOf(cellsOf(c));
      assert.equal(y, 1);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.equal(map.get(`${x + dx},1,${z + dz}`)[3], 'stone');
      assert.equal(cellsOf(c).some((cell) => cell[0] === x && cell[2] === z && cell[1] > 1), false);
    }
  }
});

test('site/origin/size and unsupported recipes reject instead of shifting, coercing or clamping', () => {
  const mutations = [
    (r) => { r.kind = 'castle'; }, (r) => { r.floors = 2; },
    (r) => { delete r.front; }, (r) => { r.origin = ['12', 12]; },
    (r) => { r.origin = [12.2, 12]; }, (r) => { r.origin = [-1, 12]; },
    (r) => { r.origin = [45, 12]; }, (r) => { r.origin = [12, 12, 12]; },
    (r) => { r.size = [6, 9]; }, (r) => { r.size = [12, 9]; },
    (r) => { r.wallHeight = 6; }, (r) => { r.wallHeight = '4'; },
    (r) => { r.front = 'north'; }, (r) => { r.roof.type = 'belltower'; },
    (r) => { r.roof.overhang = 2; }, (r) => { r.roof.overhang = true; },
    (r) => { r.roof.type = 'hip'; r.roof.ridge = 'z'; },
    (r) => { r.materials.wall = 'glass'; }, (r) => { r.materials.wall = 'stone/stair/n'; },
    (r) => { r.materials.wall = 'toString'; }, (r) => { r.windows.spacing = 5; },
    (r) => { r.windows.height = 3; }, (r) => { r.features = [{ type: 'chimney', side: 'n', size: 3 }]; },
    (r) => { r.features = [{ type: 'sign', side: 'n', size: 3, text: 'Hi' }]; },
    (r) => { r.features = [{ type: 'garden', side: 'n', size: 4 }]; },
    (r) => { r.features = [{ type: 'garden', side: 's', size: 3 }]; },
    (r) => { r.features = [{ type: 'porch', side: 'n', size: 3 }]; },
    (r) => { r.features = [{ type: 'porch', side: 's', size: 3 }]; r.size[0] = 8; },
    (r) => { r.features = Array(3).fill({ type: 'garden', side: 'n', size: 3 }); },
    (r) => { r.features = Array(2).fill({ type: 'garden', side: 'n', size: 3 }); },
    (r) => { r.origin = Array(2); }, (r) => { r.features = Array(1); },
  ];
  for (const mutate of mutations) { const r = recipe(); mutate(r); assert.throws(() => compileRecipe(r), /Recipe:/); }
  for (const site of [null, [11, 11, 25, 24], [24, 11, 11, 24], [11, 11, 21], [11, 11, 48, 24], [11, 11, 21, 21.5], [12, 12, 20, 20], [11, 11, '21', 21]]) {
    assert.throws(() => compileRecipe(recipe(), { site }), /Recipe:/);
  }
  assert.throws(() => compileRecipe(recipe({ origin: [0, 0] })), /world/);
  assert.throws(() => compileRecipe(recipe({ size: [11, 11], features: [{ type: 'porch', side: 's', size: 3 }] })), /14x14/);
  const edge = compileRecipe(recipe({ origin: [0, 0], size: [7, 7], roof: { type: 'flat', ridge: 'x', overhang: 0 } }));
  assertGeometry(edge);
});

test('persisted compiled plans reject changed cells, phase boundaries, bounds and counts', () => {
  const compiled = compileRecipe(recipe());
  for (const mutate of [
    (c) => { c.count++; }, (c) => { c.bbox[4]++; },
    (c) => { c.stages[0].cells[0][3] = 'gold'; },
    (c) => { c.stages[1].cells[0][0]++; },
    (c) => { c.stages[0].cells.pop(); },
    (c) => { c.stages[0].name = 'Different phase'; },
    (c) => { c.stages = Array(4); },
    (c) => { delete c.bbox[4]; c.bbox.extra = 9; },
    (c) => { c.stages[0].cells.push(c.stages[1].cells.shift()); },
    (c) => { c.stages[3].cells[0] = [, 1, 1, 'stone']; },
    (c) => { c.recipe.roof.overhang = 9; },
  ]) { const copy = structuredClone(compiled); mutate(copy); assert.throws(() => validateCompiled(copy), /Recipe:/); }
});

test('world applies every stage durably and logs once, with unchanged world file format', (t) => {
  const { world } = fixture(t);
  world.custom.fixture_custom = { pixels: [], colors: {} };
  world.signs['1,1,1'] = { text: 'Preserve me', facing: 's', by: 'fixture-a' };
  const originalAvatars = structuredClone(world.avatars), originalCustom = structuredClone(world.custom), originalSigns = structuredClone(world.signs);
  const compiled = compileRecipe(recipe({ kind: 'chapel' }));
  let applied = 0;
  for (const [i, stage] of compiled.stages.entries()) {
    const result = world.applyCells(stage.cells, 'fixture-a');
    assert.deepEqual(result, { changes: stage.cells, notes: [], signs: 0 });
    applied += stage.cells.length;
    assert.equal(world.blocks.size, applied);
    assert.equal(world.log.length, i + 1);
    assert.equal(world.saveTimer, null);
    const saved = JSON.parse(fs.readFileSync(world.file, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['avatars', 'blocks', 'custom', 'log', 'signs']);
    assert.deepEqual(saved.blocks, Object.fromEntries(world.blocks));
    assert.deepEqual(saved.log, world.log);
    assert.deepEqual(saved.avatars, originalAvatars);
    assert.deepEqual(saved.custom, originalCustom);
    assert.deepEqual(saved.signs, originalSigns);
    assert.deepEqual([...new World(path.dirname(path.dirname(world.file)), []).blocks], [...world.blocks]);
    const bytes = fs.readFileSync(world.file, 'utf8');
    assert.deepEqual(world.applyCells(stage.cells, 'fixture-b'), { changes: [], notes: [], signs: 0 });
    assert.equal(fs.readFileSync(world.file, 'utf8'), bytes);
  }
  assert.equal(world.blocks.size, compiled.count);
  assert.equal(fs.readdirSync(path.dirname(world.file)).length, 1, 'no abandoned temporary world file');
});

test('collision at the end of a stage leaves the entire stage, log and disk untouched', (t) => {
  const { world } = fixture(t);
  const c = compileRecipe(recipe());
  world.applyCells(c.stages[0].cells, 'fixture-a');
  const last = c.stages[1].cells.at(-1);
  world.applyCells([[...last.slice(0, 3), 'gold']], 'fixture-b');
  const blocks = world.blocks, log = world.log, bytes = fs.readFileSync(world.file, 'utf8');
  assert.throws(() => world.applyCells(c.stages[1].cells, 'fixture-a'), /conflicts/);
  assert.equal(world.blocks, blocks);
  assert.equal(world.log, log);
  assert.equal(fs.readFileSync(world.file, 'utf8'), bytes);
});

test('world strictly rejects invalid coordinates/encodings/duplicates/custom blocks/sign conflicts before any mutation', (t) => {
  const { world } = fixture(t);
  world.custom.custom_stone = {};
  const badCells = [
    [0, 0, 0, 'stone'], [48, 1, 0, 'stone'], [0, 32, 0, 'stone'], [0, 1, -1, 'stone'],
    ['0', 1, 0, 'stone'], [0.1, 1, 0, 'stone'], [NaN, 1, 0, 'stone'],
    [0, 1, 0, null], [0, 1, 0, 'STONE'], [0, 1, 0, 'stone '], [0, 1, 0, 'custom_stone'],
    [0, 1, 0, 'stone/full'], [0, 1, 0, 'stone/stair'], [0, 1, 0, 'stone/stair/x'],
    [0, 1, 0, 'stone/slab/n'], [0, 1, 0, 'stone/stair/n/extra'], [0, 1, 0, 'door'],
    [0, 1, 0, 'door/n'], [0, 1, 0, 'door/slab'], [0, 1, 0, 'door/x/extra'],
    [0, 1, 0, 'toString'], [0, 1, 0, '__proto__'], [0, 1, 0, 'stone', 'extra'],
  ];
  for (const cell of badCells) assert.throws(() => world.applyCells([[2, 1, 2, 'stone'], cell], 'fixture-a'));
  assert.throws(() => world.applyCells([[2, 1, 2, 'stone'], [2, 1, 2, 'stone']], 'fixture-a'), /Duplicate/);
  assert.throws(() => world.applyCells(Array(601).fill([2, 1, 2, 'stone']), 'fixture-a'), /600/);
  assert.throws(() => world.applyCells(null, 'fixture-a'));
  world.signs['0,1,0'] = { text: 'Reserved sign' };
  assert.throws(() => world.applyCells([[2, 1, 2, 'stone'], [0, 1, 0, 'stone']], 'fixture-a'), /sign/);
  assert.equal(world.blocks.size, 0);
  assert.equal(world.log.length, 0);
  assert.equal(fs.existsSync(world.file), false);
  assert.equal(world.saveTimer, null);
});

test('world enforces the exact stage limit and preflights the entire 80000-block capacity', (t) => {
  const { world } = fixture(t);
  const cells = Array.from({ length: 600 }, (_, i) => [i % 30, 1, Math.floor(i / 30), 'stone']);
  assert.equal(world.applyCells(cells, 'fixture-a').changes.length, 600);
  // An oversized legacy saved map can have keys outside current grid bounds;
  // capacity validation must still reject additions atomically.
  for (let i = world.blocks.size; i < 79999; i++) world.blocks.set(`legacy-${i}`, 'stone');
  const log = world.log, before = world.blocks.size;
  assert.throws(() => world.applyCells([[45, 1, 45, 'stone'], [46, 1, 46, 'stone']], 'fixture-a'), /world block limit/);
  assert.equal(world.blocks.size, before);
  assert.equal(world.blocks.has('45,1,45'), false);
  assert.equal(world.log, log);
});

test('successful stage flushes preceding raw edits before returning; raw apply remains debounced', (t) => {
  const { world } = fixture(t);
  const raw = world.apply([{ op: 'place', at: [1, 1, 1], block: 'gold' }], 'fixture-b');
  assert.equal(raw.changes.length, 1);
  assert.ok(world.saveTimer);
  assert.equal(fs.existsSync(world.file), false);
  const timer = world.saveTimer;
  world.applyCells([[2, 1, 2, 'stone']], 'fixture-a');
  assert.equal(world.saveTimer, null);
  assert.equal(timer._destroyed, true);
  const saved = JSON.parse(fs.readFileSync(world.file, 'utf8'));
  assert.equal(saved.blocks['1,1,1'], 'gold');
  assert.equal(saved.blocks['2,1,2'], 'stone');
  assert.equal(saved.log.length, 2);
});

test('identical stage flushes pending raw edits without adding a duplicate log entry', (t) => {
  const { world } = fixture(t);
  world.apply([{ op: 'place', at: [2, 1, 2], block: 'stone' }], 'fixture-a');
  assert.deepEqual(world.applyCells([[2, 1, 2, 'stone']], 'fixture-b'), { changes: [], notes: [], signs: 0 });
  assert.equal(world.saveTimer, null);
  const saved = JSON.parse(fs.readFileSync(world.file, 'utf8'));
  assert.equal(saved.blocks['2,1,2'], 'stone');
  assert.equal(saved.log.length, 1);
});

test('write/fsync/rename failures preserve memory, disk, pending timer and clean the stage temp file', (t) => {
  const { world } = fixture(t);
  world.applyCells([[1, 1, 1, 'stone']], 'fixture-a');
  world.apply([{ op: 'place', at: [2, 1, 2], block: 'brick' }], 'fixture-b');
  const blocks = world.blocks, log = world.log, timer = world.saveTimer;
  const bytes = fs.readFileSync(world.file, 'utf8');
  for (const method of ['openSync', 'writeFileSync', 'fsyncSync', 'renameSync']) {
    const original = fs[method];
    fs[method] = () => { throw new Error(`fixture ${method} failure`); };
    try { assert.throws(() => world.applyCells([[3, 1, 3, 'gold']], 'fixture-a'), /fixture .* failure/); }
    finally { fs[method] = original; }
    assert.equal(world.blocks, blocks);
    assert.equal(world.log, log);
    assert.equal(world.saveTimer, timer);
    assert.equal(timer._destroyed, false);
    assert.equal(world.blocks.has('3,1,3'), false);
    assert.equal(fs.readFileSync(world.file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(world.file)), ['world.json']);
  }
});
