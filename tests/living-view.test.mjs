// Pure synthetic public snapshots and an already installed Three.js; no server/data imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLivingView } from '../public/living-view.js';
import { buildHouse } from '../lib/house.mjs';

const threeRoot = process.env.CHATROOM_THREE_ROOT;
const THREE = threeRoot ? await import(pathToFileURL(path.join(threeRoot, 'build/three.module.js'))) : null;
const options = { skip: !THREE && 'Set CHATROOM_THREE_ROOT to an installed Three.js 0.170 package' };
const recipes = ['soup', 'burger', 'tea', 'toast', 'dumplings', 'cookies', 'fruit'];
const lifestyle = (revision = 1) => ({ revision, tableSet: true, blankets: [
  { spot: 'sofa-1', style: 'mint', owner: 'adina' }, { spot: 'sofa-4', style: 'butter', owner: 'bianca' },
  { spot: 'eleven-bed', style: 'pink', owner: 'eleven' }, { spot: 'lucia-bed', style: 'lavender', owner: 'lucia' },
] });
export function snapshot(revision = 1) {
  return { version: 1, revision, pausedAt: null,
    meal: { id: 'meal-fixture', revision, recipe: 'soup', label: '따뜻한 수프', status: 'served', cook: 'adina',
      readyAt: 1790870000000, servings: 4, remaining: 3, eatenBy: ['eleven'] },
    game: { id: 'game-fixture', revision, kind: 'tic-tac-toe', status: 'finished', players: ['adina', 'eleven'],
      board: ['X', 'X', 'X', 'O', 'O', null, null, null, null], turn: null, winner: 'adina', result: 'win',
      winningCells: [0, 1, 2], expiresAt: 1790870200000 }, events: [{ id: 'e1', at: 1790870000000, text: '아디나 승리!' }] };
}
function fixture(t, fetchState) {
  const scene = new THREE.Scene(); let invalidations = 0;
  const view = createLivingView({ THREE, scene, invalidate: () => invalidations++, fetchState });
  const house = buildHouse(); view.setHome(house.home, house.blocks);
  t.after(() => view.dispose());
  return { view, house, scene, invalidations: () => invalidations };
}
const response = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('spectator module has no timer, animation loop, controls, HTML injection or write request', () => {
  const source = fs.readFileSync(new URL('../public/living-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame|innerHTML|insertAdjacentHTML|createElement\(['"](?:a|button|input)|\bPOST\b/);
  assert.match(source, /appUrl\('\/api\/living'\)/);
  const html = fs.readFileSync(new URL('../public/world.html', import.meta.url), 'utf8');
  assert.match(html, /es\.addEventListener\('living'/);
  assert.equal((html.match(/new EventSource\(/g) || []).length, 1);
  assert.match(html, /body\.shot \.hud\s*\{\s*display: none !important/);
});

test('public revision replay stays inert; all recipes and throws reuse twelve bounded meshes', options, t => {
  const f = fixture(t), state = snapshot(), before = JSON.stringify(state);
  assert.equal(f.view.setState(state), true);
  assert.equal(JSON.stringify(state), before, 'input state is not mutated');
  const calls = f.invalidations(), stats = f.view.stats();
  assert.equal(stats.meshes, 12); assert.equal(stats.geometries, 5); assert.equal(stats.materials, 6);
  assert.equal(stats.board, true); assert.equal(stats.plates, 4); assert.equal(stats.food, 3);
  assert.equal(f.view.group.getObjectByName('living-X').count, 6);
  assert.equal(f.view.group.getObjectByName('living-O').count, 2);
  for (let i = 0; i < 50; i++) assert.equal(f.view.setState(snapshot()), false);
  assert.equal(f.view.setState(snapshot(0)), false); assert.equal(f.invalidations(), calls);
  const cooking = snapshot(2); cooking.meal.status = 'cooking'; cooking.pausedAt = 1790870000000;
  f.view.setState(cooking); assert.equal(f.view.stats().cooking, true); assert.equal(f.view.stats().plates, 0);
  const geometries = new Set(), materials = new Set(), instances = new Map();
  f.view.group.traverse(o => {
    assert.ok(!o.isLight); if (!o.isMesh) return;
    assert.equal(o.material.map, null); assert.equal(o.castShadow, false);
    geometries.add(o.geometry); materials.add(o.material);
    instances.set(o, o.instanceMatrix);
  });
  for (let i = 3; i < 150; i++) {
    const next = snapshot(i); next.meal.recipe = recipes[i % recipes.length];
    next.meal.remaining = 4; next.props = lifestyle(i - 2); f.view.setState(next);
    let triangles = 0;
    f.view.group.traverse(o => {
      if (!o.isMesh) return;
      assert.equal(o.instanceMatrix, instances.get(o), 'GPU instance buffers are never replaced');
      assert.ok(o.count <= o.instanceMatrix.count, o.name);
      assert.ok(materials.has(o.material), 'materials are shared for every recipe/style');
      if (i < 10) geometries.add(o.geometry);
      else assert.ok(geometries.has(o.geometry), 'recipe replay never allocates geometry');
      triangles += o.geometry.index.count / 3 * o.instanceMatrix.count;
    });
    assert.ok(triangles < 8000, `maximum allocated triangle capacity: ${triangles}`);
  }
  assert.equal(geometries.size, 5); assert.equal(f.view.stats().geometries, 5);
  let disposedG = 0, disposedM = 0, disposedInstances = 0;
  geometries.forEach(g => g.addEventListener('dispose', () => disposedG++));
  materials.forEach(m => m.addEventListener('dispose', () => disposedM++));
  f.view.group.traverse(o => { if (o.isMesh) o.addEventListener('dispose', () => disposedInstances++); });
  f.view.dispose(); f.view.dispose();
  assert.equal(disposedG, geometries.size); assert.equal(disposedM, materials.size); assert.equal(disposedInstances, 12);
  assert.equal(f.scene.children.length, 0);
  assert.equal(f.view.stats().food, 0); assert.equal(f.view.stats().blankets, 0); assert.equal(f.view.stats().cups, 0);
  assert.equal(f.view.stats().visibleMeshes, 0); assert.equal(f.view.stats().geometries, 0);
  const disposedCalls = f.invalidations();
  assert.equal(f.view.setState(snapshot(999)), false); f.view.setHome(f.house.home, f.house.blocks);
  assert.equal(f.invalidations(), disposedCalls);
});

test('ready meals keep the kitchen pot; only served meals place food on the table', options, t => {
  const { view } = fixture(t); let revision = 0;
  for (const recipe of recipes) {
    for (const status of ['cooking', 'ready', 'served', 'finished']) {
      const next = snapshot(++revision);
      Object.assign(next.meal, { recipe, status, remaining: status === 'finished' ? 0 : 4, eatenBy: [] });
      view.setState(next);
      assert.equal(view.stats().cooking, ['cooking', 'ready'].includes(status), `${recipe}/${status} pot`);
      assert.equal(view.stats().plates, ['served', 'finished'].includes(status) ? 4 : 0, `${recipe}/${status} plates`);
      assert.equal(view.stats().cups, view.stats().plates, `${recipe}/${status} cups follow plates`);
      assert.equal(view.stats().food, status === 'served' ? 4 : 0, `${recipe}/${status} food`);
      assert.equal(view.stats().foodInstances > 0, status === 'served');
      if (status !== 'served') {
        assert.equal(view.group.getObjectByName('living-food').count, 0);
        assert.equal(view.group.getObjectByName('living-food-details').count, status === 'finished' ? 12 : 0);
        assert.equal(view.group.getObjectByName('living-food-layers').count, status === 'finished' ? 8 : 0);
      }
    }
  }
});

test('optional props migrate to empty revision zero; scoped revisions do not follow meals or games', options, t => {
  const { view, invalidations } = fixture(t);
  const next = snapshot(10); next.meal = null; next.game = null;
  view.setState(next);
  assert.equal(view.stats().propsRevision, 0); assert.equal(view.stats().blankets, 0); assert.equal(view.stats().plates, 0);
  assert.equal(view.stats().cups, 0);
  next.revision++; next.props = lifestyle(1); view.setState(next);
  assert.equal(view.stats().propsRevision, 1); assert.equal(view.stats().plates, 4); assert.equal(view.stats().cups, 4);
  assert.equal(view.stats().foodInstances, 0); assert.equal(view.stats().blankets, 4);
  const calls = invalidations(); assert.equal(view.setState(structuredClone(next)), false); assert.equal(invalidations(), calls);
  next.revision++; next.meal = snapshot().meal; view.setState(next);
  assert.equal(view.stats().propsRevision, 1); assert.equal(view.stats().food, 3);
  next.revision++; next.props.revision++; next.props.tableSet = false; view.setState(next);
  assert.equal(view.stats().plates, 4, 'served food keeps its plates even if tableSet is false');
  next.revision++; next.meal = null; next.props.blankets = []; next.props.revision++; view.setState(next);
  assert.equal(view.stats().visibleMeshes, 0); assert.equal(view.stats().cups, 0);
  next.revision++; delete next.props; view.setState(next);
  assert.equal(view.stats().propsRevision, 0); assert.equal(view.stats().blankets, 0);
});

test('pre-set table never invents food in any unserved stage or after clearing', options, t => {
  const { view } = fixture(t); let revision = 0;
  for (const recipe of recipes) for (const status of [null, 'cooking', 'ready', 'served', 'finished']) {
    const next = snapshot(++revision); next.props = { revision, tableSet: true, blankets: [] };
    if (status === null) next.meal = null;
    else Object.assign(next.meal, { recipe, status, remaining: 2 });
    view.setState(next);
    assert.equal(view.stats().plates, 4);
    assert.equal(view.stats().cups, 4);
    assert.equal(view.stats().food, status === 'served' ? 2 : 0);
    assert.equal(view.stats().foodInstances > 0, status === 'served');
  }
});

test('malformed blankets, private owners and unbounded props preserve the last valid scene', options, async t => {
  let value;
  const { view, invalidations } = fixture(t, async () => response(value));
  const valid = snapshot(10); valid.props = lifestyle(); view.setState(valid);
  const known = view.stats(), calls = invalidations();
  for (const edit of [
    s => { s.props = null; }, s => { s.props.tableSet = 1; }, s => { delete s.props.blankets; },
    s => { s.props.revision = -1; }, s => { s.props.revision = 1.5; }, s => { s.props.revision = Infinity; },
    s => { s.props.blankets.push({ spot: 'sofa-2', style: 'mint', owner: 'adina' }); },
    s => { s.props.blankets[1].spot = 'sofa-1'; }, s => { s.props.blankets[0].spot = 'floor'; },
    s => { s.props.blankets[0].spot = ['sofa-1']; }, s => { s.props.blankets[0].style = ['mint']; },
    s => { s.props.blankets[0].owner = ['adina']; }, s => { s.meal.recipe = ['dumplings']; },
    s => { s.props.blankets[0].style = '__proto__'; }, s => { s.props.blankets[0].owner = 'gpt'; },
    s => { s.props.blankets[0] = null; }, s => { s.meal.recipe = 'unknown'; },
  ]) {
    value = snapshot(11); value.props = lifestyle(); edit(value);
    assert.equal(view.setState(value), false); assert.equal(await view.reload(), false);
    assert.deepEqual(view.stats(), known); assert.equal(invalidations(), calls);
  }
});

test('recognizable recipe parts are bounded and decrease with servings, with no stale detail', options, t => {
  const { view } = fixture(t); let revision = 0;
  const bodies = view.group.getObjectByName('living-food'), details = view.group.getObjectByName('living-food-details');
  for (const [recipe, perServing, detailCount] of [['dumplings', 3, 15], ['cookies', 2, 10], ['fruit', 3, 6], ['burger', 2, 6]]) {
    for (const remaining of [4, 1, 0]) {
      const next = snapshot(++revision); Object.assign(next.meal, { recipe, remaining }); view.setState(next);
      assert.equal(bodies.count, remaining * perServing); assert.equal(details.count, remaining * detailCount + 12);
      for (let i = 0; i < remaining * detailCount; i++) {
        const m = new THREE.Matrix4(); details.getMatrixAt(i, m);
        assert.ok(m.elements.every(Number.isFinite)); assert.ok(m.elements[13] > .04, 'detail sits above its plate');
      }
    }
  }
  const next = snapshot(++revision); next.meal.recipe = 'tea'; view.setState(next);
  assert.equal(details.count, 12); assert.equal(view.group.getObjectByName('living-food-layers').count, 8);
});

test('cups reuse bounded food batches, clear completely and follow real dining blocks', options, t => {
  const { view, house } = fixture(t), next = snapshot(); next.meal = null; next.game = null;
  next.props = { revision: 1, tableSet: true, blankets: [] }; view.setState(next);
  const layers = view.group.getObjectByName('living-food-layers'), details = view.group.getObjectByName('living-food-details');
  assert.equal(layers.instanceMatrix.count, 24); assert.equal(details.instanceMatrix.count, 80);
  assert.equal(layers.count, 8); assert.equal(details.count, 12);
  assert.equal(view.stats().cups, 4); assert.equal(view.stats().foodInstances, 0);
  for (let i = 0; i < 4; i++) {
    const body = new THREE.Matrix4(), inner = new THREE.Matrix4();
    layers.getMatrixAt(i * 2, body); layers.getMatrixAt(i * 2 + 1, inner);
    assert.ok(Math.abs(Math.abs(body.elements[12]) - .65) < 1e-6);
    assert.equal(inner.elements[12], body.elements[12]); assert.equal(inner.elements[14], body.elements[14]);
    assert.ok(inner.elements[0] < body.elements[0], 'visible ceramic rim surrounds the recessed interior');
  }
  const key = '25,4,32', saved = house.blocks[key]; delete house.blocks[key]; view.setHome(house.home, house.blocks);
  assert.equal(view.stats().cups, 0); assert.equal(layers.count, 0); assert.equal(details.count, 0);
  house.blocks[key] = saved; view.setHome(house.home, house.blocks); assert.equal(view.stats().cups, 4);
  next.revision++; next.props.revision++; next.props.tableSet = false; view.setState(next);
  assert.equal(view.stats().cups, 0); assert.equal(layers.count, 0); assert.equal(details.count, 0);
  assert.equal(view.stats().visibleMeshes, 0);
});

test('all eight blanket anchors rest on real sofa/bed surfaces, and missing or rotated blocks hide throws', options, t => {
  const { view, house, invalidations } = fixture(t);
  const spots = ['sofa-1', 'sofa-2', 'sofa-3', 'sofa-4', 'adina-bed', 'bianca-bed', 'eleven-bed', 'lucia-bed'];
  const blankets = view.group.getObjectByName('living-blankets'); let revision = 0;
  for (const spot of spots) {
    const next = snapshot(++revision); next.meal = null; next.game = null;
    next.props = { revision, tableSet: false, blankets: [{ spot, style: 'mint', owner: 'adina' }] }; view.setState(next);
    assert.equal(view.stats().blankets, 1);
    const f = house.home.furniture[spot], matrix = new THREE.Matrix4(); blankets.getMatrixAt(0, matrix);
    assert.ok(Math.abs(matrix.elements[12] - f.at[0] - .5) < .2, spot);
    assert.ok(Math.abs(matrix.elements[14] - f.at[2] - .5) < .3, spot);
    for (let i = 0; i < blankets.count; i++) {
      blankets.getMatrixAt(i, matrix);
      assert.ok(matrix.elements[13] - matrix.elements[5] / 2 > f.at[1] - 1 + .2, 'no new floor blanket');
    }
    const key = f.at.join(','), saved = house.blocks[key];
    delete house.blocks[key]; view.setHome(house.home, new Map(Object.entries(house.blocks)));
    assert.equal(view.stats().blankets, 0);
    house.blocks[key] = saved.replace(/\/[es]$/, '/n'); view.setHome(house.home, house.blocks);
    assert.equal(view.stats().blankets, 0);
    house.blocks[key] = saved; view.setHome(house.home, house.blocks);
    assert.equal(view.stats().blankets, 1);
    const calls = invalidations(); view.setHome(house.home, house.blocks); assert.equal(invalidations(), calls);
  }
  view.setHome({ ...house.home, id: 'another-home' }, house.blocks); assert.equal(view.stats().blankets, 0);
  assert.equal(view.stats().visibleMeshes, 0);
});

test('unavailable SSE preserves the scene and prevents an older in-flight GET from replacing it', options, async t => {
  const pending = deferred();
  const { view, invalidations } = fixture(t, () => pending.promise);
  view.setState(snapshot(5)); const known = view.stats(), calls = invalidations();
  const loading = view.reload();
  assert.equal(view.setState({ unavailable: true }), false);
  pending.resolve(response(snapshot(6))); assert.equal(await loading, false);
  assert.deepEqual(view.stats(), known); assert.equal(invalidations(), calls);
  assert.equal(view.setState(snapshot(6)), true);
  assert.equal(view.stats().revision, 6);
});

test('props use actual furniture and disappear when anchors are removed or home changes', options, t => {
  const { view, house } = fixture(t); view.setState(snapshot());
  const board = view.group.getObjectByName('living-board').parent;
  assert.deepEqual(board.position.toArray(), [15.5, 3.92, 33.76]);
  assert.deepEqual(view.group.getObjectByName('living-plates').parent.position.toArray(), [26.5, 4.045, 33]);
  delete house.blocks['15,4,33']; delete house.blocks['25,4,32'];
  view.setHome(house.home, house.blocks);
  assert.equal(view.stats().board, false); assert.equal(view.stats().plates, 0);
  view.setHome(null, {}); assert.equal(view.stats().visibleMeshes, 0);
});

test('GET permits an authoritative revision reset but never rolls back an in-flight SSE', options, async t => {
  const queue = [];
  const { view } = fixture(t, () => { const d = deferred(); queue.push(d); return d.promise; });
  view.setState(snapshot(10));
  const pending = view.reload(); view.setState(snapshot(11)); queue.shift().resolve(response(snapshot(0)));
  assert.equal(await pending, false); assert.equal(view.stats().revision, 11);
  const reset = view.reload(); queue.shift().resolve(response(snapshot(0)));
  assert.equal(await reset, true); assert.equal(view.stats().revision, 0);
  assert.equal(view.setState(snapshot(1)), true);
  view.setState(snapshot(20));
  const resetWithEvent = view.reload();
  assert.equal(view.setState(snapshot(2)), false, 'lower SSE awaits confirmation of a reset');
  queue.shift().resolve(response(snapshot(1))); await resetWithEvent;
  assert.equal(view.stats().revision, 2, 'the new lifetime keeps its newer in-flight SSE');
  const replayDuringReset = view.reload(); view.setState(snapshot(2));
  queue.shift().resolve(response(snapshot(0))); await replayDuringReset;
  assert.equal(view.stats().revision, 0, 'an unchanged replay cannot suppress authoritative reset');
  const old = view.reload(), current = view.reload();
  queue[1].resolve(response(snapshot(3))); await current;
  queue[0].resolve(response(snapshot(2))); await old; queue.length = 0;
  assert.equal(view.stats().revision, 3);
  const last = view.reload(); view.dispose(); queue.shift().resolve(response(snapshot(4)));
  assert.equal(await last, false);
});

test('failed or malformed snapshots preserve the last known scene instead of inventing empty state', options, async t => {
  let value = { ok: false };
  const { view } = fixture(t, async () => value);
  await view.reload(); assert.equal(view.stats().revision, null);
  view.setState(snapshot(5)); const known = view.stats();
  await view.reload(); assert.deepEqual(view.stats(), known);
  value = response({ version: 2, revision: 99 }); await view.reload(); assert.deepEqual(view.stats(), known);
  const invalid = snapshot(6); invalid.game.board.push('X'); assert.equal(view.setState(invalid), false);
  value = response({ version: 1, revision: 0, pausedAt: null, meal: null, game: null, events: [] });
  await view.reload(); assert.equal(view.stats().visibleMeshes, 0); assert.equal(view.stats().revision, 0);
});
