import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World, PALETTE, SHAPES, parseBlock } from '../lib/world.mjs';
import { getLang, setLang } from '../lib/i18n.mjs';
import { FURNITURE, FURNITURE_SHAPES, FACING_VECTOR, FACING_TURN, furnitureBatch, furnitureGeometry, drawMaterial, materialSize } from '../public/world-materials.js';

function fixture(t, saved = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-furniture-'));
  fs.mkdirSync(path.join(home, 'data'));
  fs.writeFileSync(path.join(home, 'data', 'world.json'), JSON.stringify(saved));
  const w = new World(home, ['a', 'b']);
  t.after(() => { clearTimeout(w.saveTimer); fs.rmSync(home, { recursive: true, force: true }); });
  return w;
}
const place = (w, shape, at = [12, 1, 12], facing = 'n') => w.apply({ op: 'place', block: 'planks', shape, facing, at }, 'a');

test('direct furniture builds encode all shapes/facings without new block names', (t) => {
  const w = fixture(t);
  for (const shape of FURNITURE_SHAPES) for (const facing of ['n', 'e', 's', 'w']) {
    const result = place(w, shape, [12, 1, 12], facing);
    assert.deepEqual(result.notes, []);
    assert.equal(w.blocks.get('12,1,12'), `planks/${shape}/${facing}`);
    assert.deepEqual(parseBlock(result.changes[0][3]), { type: 'planks', shape, facing });
    assert.ok(SHAPES.includes(shape));
    assert.equal(PALETTE[shape], undefined);
  }
  assert.equal(place(w, 'chair', [12, 1, 12], 'up').changes.length, 0);
  assert.equal(place(w, 'wardrobe').changes.length, 0);
  assert.equal(w.apply({ block: 'stone', shape: 'chair', at: [12, 1, 12] }, 'a').changes[0][3], 'stone/chair/n');
});

test('chair and bench sit; bed reclines at the exact rendered surface', (t) => {
  const w = fixture(t);
  for (const shape of ['chair', 'bench', 'bed']) {
    place(w, shape);
    const result = w.useFurniture('a', [12, 1, 12]);
    assert.equal(result.ok, true);
    assert.equal(result.avatar.posture, FURNITURE[shape].posture);
    assert.equal(result.avatar.y, 1 + FURNITURE[shape].surface);
    assert.equal(result.avatar.facing, 'n');
    assert.deepEqual(result.avatar.furniture, { at: [12, 1, 12], shape });
    assert.equal('block' in result.avatar.furniture, false);
    assert.equal('returnTo' in result.avatar.furniture, false);
    assert.equal(w.useFurniture('a', { x: 12, y: 1, z: 12 }).ok, true, 'repeat use is idempotent');
  }
});

test('tables/workbenches work from their front, facing towards the surface', (t) => {
  const w = fixture(t);
  for (const shape of ['table', 'workbench']) for (const [facing, [dx, dz]] of Object.entries(FACING_VECTOR)) {
    place(w, shape, [12, 1, 12], facing);
    const { ok, avatar } = w.useFurniture('a', [12, 1, 12]);
    assert.equal(ok, true);
    assert.equal(avatar.posture, 'work');
    assert.deepEqual([avatar.x, avatar.y, avatar.z], [12 + dx, 1, 12 + dz]);
    const dir = FACING_VECTOR[avatar.facing];
    assert.equal(dir[0] + dx, 0); assert.equal(dir[1] + dz, 0);
  }
});

test('occupied furniture and occupied approach cannot be stolen', (t) => {
  const w = fixture(t);
  place(w, 'chair');
  w.useFurniture('a', [12, 1, 12]);
  const before = structuredClone(w.avatars);
  assert.deepEqual(w.useFurniture('b', [12, 1, 12]), { ok: false, error: 'occupied' });
  assert.deepEqual(w.avatars, before);
  place(w, 'table', [20, 1, 20]);
  w.move('b', [20, 19]);
  assert.deepEqual(w.useFurniture('a', [20, 1, 20]), { ok: false, error: 'occupied' });
  assert.equal(w.avatarView().a.posture, 'sit', 'failed switching preserves the current seat');
});

test('release returns to the previous floor position; moving releases occupation', (t) => {
  const w = fixture(t);
  w.move('a', [10, 12]);
  place(w, 'chair');
  w.useFurniture('a', [12, 1, 12]);
  const release = w.useFurniture('a', null);
  assert.deepEqual([release.avatar.x, release.avatar.y, release.avatar.z, release.avatar.posture], [10, 1, 12, 'stand']);
  assert.equal(release.avatar.furniture, undefined);
  w.useFurniture('a', [12, 1, 12]);
  assert.equal(w.move('a', [13, 12]), true);
  assert.equal(w.avatarView().a.posture, 'stand');
  assert.equal(w.useFurniture('b', [12, 1, 12]).ok, true);
});

test('removing or replacing furniture invalidates use, including remove/rebuild in one operation list', (t) => {
  const w = fixture(t);
  for (const ops of [
    [{ op: 'remove', at: [12, 1, 12] }],
    [{ block: 'stone', at: [12, 1, 12] }],
    [{ op: 'remove', at: [12, 1, 12] }, { block: 'planks', shape: 'chair', at: [12, 1, 12] }],
  ]) {
    place(w, 'chair'); w.useFurniture('a', [12, 1, 12]);
    w.apply(ops, 'b');
    assert.equal(w.avatarView().a.posture, 'stand');
    assert.equal(w.avatarView().a.furniture, undefined);
  }
});

test('invalid input, floating furniture, low ceilings and blocked approaches fail without mutation', (t) => {
  const w = fixture(t);
  assert.deepEqual(w.useFurniture('missing', [1, 1, 1]), { ok: false, error: 'unknown_avatar' });
  for (const at of [undefined, {}, [], [12, 1], [12, 1, 12, 0], [12.1, 1, 12], [-1, 1, 1], [1, 0, 1], ['12', 1, 12]]) {
    assert.deepEqual(w.useFurniture('a', at), { ok: false, error: 'invalid_target' });
  }
  assert.deepEqual(w.useFurniture('a', [12, 1, 12]), { ok: false, error: 'not_furniture' });
  place(w, 'chair', [12, 4, 12]);
  assert.deepEqual(w.useFurniture('a', [12, 4, 12]), { ok: false, error: 'unsupported' });
  place(w, 'chair'); w.apply({ block: 'stone', at: [12, 2, 12] }, 'a');
  assert.deepEqual(w.useFurniture('a', [12, 1, 12]), { ok: false, error: 'blocked' });
  place(w, 'table', [20, 1, 20]); w.apply({ block: 'stone', at: [20, 1, 19] }, 'b');
  const before = structuredClone(w.avatars);
  assert.deepEqual(w.useFurniture('a', [20, 1, 20]), { ok: false, error: 'blocked' });
  assert.deepEqual(w.avatars, before);
  place(w, 'workbench', [0, 1, 0]);
  assert.deepEqual(w.useFurniture('a', [0, 1, 0]), { ok: false, error: 'blocked' });
});

test('indoor standing stays below roofs, steps up floors, and respects slab height/headroom', (t) => {
  const w = fixture(t);
  w.apply([{ op: 'fill', block: 'stone', from: [10, 1, 10], to: [15, 1, 15] },
    { op: 'fill', block: 'planks', from: [10, 5, 10], to: [15, 5, 15] }], 'a');
  assert.equal(w.move('a', [12, 12]), true);
  assert.equal(w.topY(12, 12), 5, 'top-view maps retain the highest block');
  assert.equal(w.avatarView().a.y, 2, 'feet on the interior floor, not roof');
  w.apply({ block: 'stone', shape: 'slab', at: [16, 1, 12] }, 'b');
  assert.equal(w.move('a', [16, 12]), true);
  assert.equal(w.avatarView().a.y, 1.5);
  w.apply({ block: 'stone', at: [17, 2, 12] }, 'b');
  assert.equal(w.move('a', [17, 12]), false, 'cannot stand inside low ceiling or leap onto it');
  w.apply({ block: 'door', at: [18, 1, 12] }, 'b');
  assert.equal(w.move('a', [18, 12]), true);
  assert.equal(w.avatarView().a.y, 1);
});

test('furniture under a roof uses its floor; removing support or adding a ceiling releases it', (t) => {
  const w = fixture(t);
  w.apply([{ block: 'stone', at: [12, 1, 12] }, { block: 'stone', at: [12, 5, 12] }], 'a');
  place(w, 'chair', [12, 2, 12]);
  assert.equal(w.useFurniture('a', [12, 2, 12]).avatar.y, 2.46);
  w.apply({ op: 'remove', at: [12, 1, 12] }, 'a');
  assert.equal(w.avatarView().a.posture, 'stand');
  w.apply({ block: 'stone', at: [12, 1, 12] }, 'a');
  w.useFurniture('a', [12, 2, 12]);
  w.apply({ block: 'stone', at: [12, 3, 12] }, 'b');
  assert.equal(w.avatarView().a.posture, 'stand');
});

test('legacy avatars load onto an interior floor; seated state survives a reload', (t) => {
  const w = fixture(t, { blocks: { '12,1,12': 'stone', '12,5,12': 'stone' }, avatars: { a: { x: 12, z: 12 } } });
  assert.equal(w.avatarView().a.y, 2);
  place(w, 'chair', [12, 2, 12]); w.useFurniture('a', [12, 2, 12]);
  fs.writeFileSync(w.file, JSON.stringify({ blocks: Object.fromEntries(w.blocks), avatars: w.avatars }));
  const reloaded = new World(path.dirname(path.dirname(w.file)), ['a', 'b']);
  const persistent = Object.fromEntries(Object.entries(w.avatarView()).map(([id, {path, moveId, ...pose}]) => [id, pose]));
  assert.deepEqual(reloaded.avatarView(), persistent);
  assert.equal(reloaded.avatarView().a.path, undefined, 'a reload must not replay the previous walk');
  reloaded.apply({ op: 'remove', at: [12, 2, 12] }, 'b');
  clearTimeout(reloaded.saveTimer);
  assert.equal(reloaded.avatarView().a.posture, 'stand');
});

test('compiled furniture cells share direct-build encoding and invalid batches stay atomic', (t) => {
  const w = fixture(t);
  const cells = FURNITURE_SHAPES.map((s, i) => [20 + i, 1, 20, `planks/${s}/n`]);
  assert.deepEqual(w.applyCells(cells, 'a').changes, cells);
  assert.equal(w.useFurniture('a', [20, 1, 20]).ok, true);
  const before = JSON.stringify(w.view());
  assert.throws(() => w.applyCells([[8, 1, 8, 'planks/chair/up']], 'a'), /Invalid encoded/);
  assert.equal(JSON.stringify(w.view()), before);
  assert.throws(() => w.applyCells([[8, 1, 8, 'planks/chair']], 'a'), /Invalid encoded/);
  w.applyCells([[20, 2, 20, 'stone']], 'b');
  assert.equal(w.avatarView().a.posture, 'stand');
  assert.equal(JSON.parse(fs.readFileSync(w.file)).avatars.a.posture, 'stand', 'avatar invalidation participates in the same plan write');
});

test('single-cell furniture keeps bounded triangles and facings share each batch', () => {
  for (const [shape, spec] of Object.entries(FURNITURE)) {
    assert.ok(spec.boxes.length <= 10, `${shape} exceeds the fixed geometry budget`);
    for (const [w, h, d, x, y, z] of spec.boxes) {
      assert.ok(w > 0 && h > 0 && d > 0);
      assert.ok(Math.abs(x) + w / 2 <= 0.50001 && Math.abs(z) + d / 2 <= 0.50001);
      assert.ok(y - h / 2 >= -0.00001 && y + h / 2 <= 1.00001);
    }
    const batches = new Set(Object.keys(FACING_VECTOR).map(() => furnitureBatch('planks', shape)));
    assert.equal(batches.size, 1);
  }
  for (const [facing, [dx, dz]] of Object.entries(FACING_VECTOR)) {
    const angle = FACING_TURN[facing];
    assert.ok(Math.abs(-Math.sin(angle) - dx) < 1e-6 && Math.abs(-Math.cos(angle) - dz) < 1e-6, 'rendered front agrees with usable approach');
  }
});

test('furniture geometry factory merges without material groups and disposes its construction pieces', () => {
  const pieces = [];
  class BoxGeometry {
    constructor() { this.attributes = { position: { count: 24 } }; this.groups = [1, 2, 3, 4, 5, 6]; pieces.push(this); }
    translate() { return this; }
    setAttribute(k, v) { this.attributes[k] = v; }
    clearGroups() { this.groups = []; }
    dispose() { this.disposed = true; }
  }
  class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; } }
  for (const shape of FURNITURE_SHAPES) {
    const g = furnitureGeometry({ BoxGeometry, BufferAttribute }, (gs, groups) => {
      assert.equal(groups, false); assert.equal(gs.length, FURNITURE[shape].boxes.length);
      assert.ok(gs.every((p) => p.groups.length === 0 && p.attributes.color.array.length === 72));
      return { groups: [1], clearGroups() { this.groups = []; } };
    }, shape);
    assert.equal(g.groups.length, 0);
  }
  assert.ok(pieces.every((p) => p.disposed));
});

test('procedural texture tiles are deterministic, bounded, and contain material detail', () => {
  const draw = (name, hex) => {
    const size = materialSize(name), pixels = Array(size * size).fill('');
    const g = { fillStyle: '', fillRect(x, y, w, h) {
      assert.ok(x >= 0 && y >= 0 && x + w <= size && y + h <= size, `${name} draw bounds`);
      for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) pixels[py * size + px] = this.fillStyle;
    } };
    drawMaterial(g, size, name, hex);
    assert.ok([32, 64].includes(size));
    assert.ok(pixels.every(Boolean));
    assert.ok(new Set(pixels).size >= 3, `${name} needs visible detail`);
    return pixels;
  };
  for (const [name, [, hex]] of Object.entries(PALETTE)) if (name !== 'lamp') assert.deepEqual(draw(name, hex), draw(name, hex));
});

function furnitureSection(summary) {
  const lines = summary.split('\n');
  const start = lines.findIndex((line) => /^(가구|Furniture|家具) \(/.test(line));
  if (start < 0) return '';
  const section = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!/^(?:- \(|…)/.test(line)) break;
    section.push(line);
  }
  return section.join('\n');
}

test('furniture summary exposes actionable coordinates, shape, facing and presentation names in ko/en/ja', (t) => {
  const w = fixture(t, { avatars: { gemini: { x: 4, z: 4 } } });
  const original = getLang(); t.after(() => setLang(original));
  FURNITURE_SHAPES.forEach((shape, i) => place(w, shape, [10 + i * 2, 1, 12], ['n', 'e', 's', 'w', 'n'][i]));
  assert.equal(w.useFurniture('gemini', [10, 1, 12]).ok, true);
  const names = { gemini: '비앙카', a: '일레븐', b: '아디나' };
  for (const [language, heading, occupied, free] of [
    ['ko', '가구', '사용 중: 비앙카', '비어 있음'],
    ['en', 'Furniture', 'in use: 비앙카', 'unoccupied'],
    ['ja', '家具', '使用中: 비앙카', '空き'],
  ]) {
    setLang(language);
    const calls = [], before = JSON.stringify(w.avatars), timer = w.saveTimer;
    const summary = w.summary('gemini', (id) => { calls.push(id); assert.ok(Object.hasOwn(names, id)); return names[id]; });
    const section = furnitureSection(summary);
    assert.ok(section.startsWith(heading));
    assert.ok(section.includes('useFurniture:[x,y,z]'));
    assert.ok(section.includes(`- (10,1,12) chair/n · ${occupied}`));
    for (const [at, shape] of [['12,1,12', 'table/e'], ['14,1,12', 'bench/s'], ['16,1,12', 'bed/w'], ['18,1,12', 'workbench/n']]) {
      assert.ok(section.includes(`- (${at}) ${shape} · ${free}`));
    }
    assert.doesNotMatch(summary, /gemini|claude|deepseek|\bgpt\b/);
    assert.ok(calls.filter((id) => id === 'gemini').length >= 2, 'occupancy and position both resolve the display-name callback');
    assert.equal(JSON.stringify(w.avatars), before, 'summary is read-only');
    assert.equal(w.saveTimer, timer, 'summary does not schedule persistence');
  }
});

test('summary occupancy follows release, movement, replacement and removal', (t) => {
  const w = fixture(t);
  const original = getLang(); setLang('en'); t.after(() => setLang(original));
  const summary = () => furnitureSection(w.summary('a', (id) => id === 'a' ? 'Eleven' : 'Bianca'));
  assert.equal(summary(), '', 'empty worlds need no furniture prompt section');
  place(w, 'chair');
  w.useFurniture('a', [12, 1, 12]); assert.match(summary(), /chair\/n · in use: Eleven/);
  w.useFurniture('a', null); assert.match(summary(), /chair\/n · unoccupied/);
  w.useFurniture('a', [12, 1, 12]); w.move('a', [13, 12]);
  assert.match(summary(), /chair\/n · unoccupied/);
  w.useFurniture('a', [12, 1, 12]); place(w, 'workbench', [12, 1, 12], 'w');
  assert.match(summary(), /workbench\/w · unoccupied/);
  assert.doesNotMatch(summary(), /chair|in use/);
  w.apply({ op: 'remove', at: [12, 1, 12] }, 'b');
  assert.equal(summary(), '');
});

test('summary caps furniture at 12 entries with explicit omissions and prioritizes current occupants', (t) => {
  const w = fixture(t);
  const original = getLang(); t.after(() => setLang(original));
  for (let x = 0; x < 30; x++) place(w, 'chair', [x, 1, 20]);
  w.move('a', [0, 19]);
  assert.equal(w.useFurniture('b', [29, 1, 20]).ok, true);
  for (const [language, omission] of [['ko', '…가구 18개 생략'], ['en', '…18 furniture entries omitted'], ['ja', '…家具18件を省略']]) {
    setLang(language);
    const section = furnitureSection(w.summary('a', (id) => id === 'b' ? 'Bianca' : 'Eleven'));
    assert.equal(section.split('\n').filter((s) => s.startsWith('- (')).length, 12);
    assert.match(section.split('\n')[1], /^- \(29,1,20\) chair\/n/, 'occupied pieces survive the cap even far from the observer');
    assert.ok(section.includes('(0,1,20)'), 'nearest unoccupied pieces remain discoverable');
    assert.ok(section.includes(omission));
    assert.match(section.split('\n')[0], /12.*1200/);
    assert.ok(section.length <= 1200);
    assert.equal(section, furnitureSection(w.summary('a', (id) => id === 'b' ? 'Bianca' : 'Eleven')));
  }
});

test('complete furniture section has a hard character cap even with long multibyte display names', (t) => {
  const w = fixture(t);
  const original = getLang(); setLang('en'); t.after(() => setLang(original));
  w.avatars = {};
  for (let x = 0; x < 20; x++) {
    place(w, 'chair', [x, 1, 20]);
    w.avatars[`member_${x}`] = { x, y: 1, z: 21 };
    assert.equal(w.useFurniture(`member_${x}`, [x, 1, 20]).ok, true);
  }
  const section = furnitureSection(w.summary('member_19', () => '🙂'.repeat(200) + '\nextra'));
  const rows = section.split('\n').filter((s) => s.startsWith('- ('));
  assert.ok(section.length <= 1200);
  assert.ok(rows.length > 0 && rows.length < 12, 'character budget can truncate before the item cap');
  assert.match(rows[0], /^- \(19,1,20\)/, 'the observer’s own occupied furniture comes first');
  assert.ok(section.endsWith(`…${20 - rows.length} furniture entries omitted`));
  assert.doesNotMatch(section, /member_|extra/);
  for (const row of rows) assert.equal([...row.split('in use: ')[1]].length, 32, 'display-name truncation keeps whole Unicode characters');
});
