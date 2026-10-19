// Uses an already installed Three 0.170 tree; never downloads dependencies.
// CHATROOM_THREE_ROOT=/path/to/three node --test tests/world-diorama.test.mjs
// Optional DIORAMA_SCREENSHOT_DIR enables the isolated, synthetic browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { buildHouse } from '../lib/house.mjs';

const root = path.resolve(import.meta.dirname, '..');
const threeRoot = process.env.CHATROOM_THREE_ROOT;
const source = fs.readFileSync(path.join(root, 'public/world-diorama.js'), 'utf8');
let THREE, createDiorama;
if (threeRoot) {
  THREE = await import(pathToFileURL(path.join(threeRoot, 'build/three.module.js')));
  const resolved = source.replace("'three/addons/utils/BufferGeometryUtils.js'",
    JSON.stringify(pathToFileURL(path.join(threeRoot, 'examples/jsm/utils/BufferGeometryUtils.js')).href));
  ({ createDiorama } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`));
}
const needsThree = { skip: threeRoot ? false : 'Set CHATROOM_THREE_ROOT to an existing Three.js 0.170 package' };
const make = fixture => createDiorama({ THREE, home: fixture.home, blocks: new Map(Object.entries(fixture.blocks)) });

test('dining settings are not baked into the house after the living table is cleared', needsThree, () => {
  const d=make(buildHouse()); d.group.updateMatrixWorld(true);
  const ray=new THREE.Raycaster();
  for(const x of [25.58,27.42]) for(const z of [32.48,33.52]) {
    for(const px of [x,x+(x<26.5?.27:-.27)]) {
      ray.set(new THREE.Vector3(px,4.4,z),new THREE.Vector3(0,-1,0));
      ray.near=0;ray.far=.37; // stop 2 cm above the tabletop (float tolerance)
      assert.equal(ray.intersectObject(d.group,true).length,0,'no permanent plate or cup above the table');
    }
  }
  d.dispose();
});

test('smooth house fits its complete draw/triangle budget and owns no lights or textures', needsThree, () => {
  const fixture = buildHouse(), before = JSON.stringify(fixture), d = make(fixture);
  const cut = d.stats();
  assert.ok(cut.meshes < 60);
  assert.ok(cut.totalMeshes < 60);
  assert.ok(cut.totalTriangles < 80000, JSON.stringify(cut));
  assert.ok(cut.visibleInstances > 500);
  const geometries = new Set(), materials = new Set();
  d.group.traverse(n => {
    assert.ok(!n.isLight);
    if (!n.isMesh) return;
    assert.ok(!n.castShadow && !n.receiveShadow);
    assert.ok(n.material.isMeshLambertMaterial);
    assert.equal(n.material.map, null);
    assert.equal(n.geometry.groups.length, 0, 'each material batch is one draw');
    geometries.add(n.geometry); materials.add(n.material);
    for (const attribute of ['position', 'normal']) assert.ok([...n.geometry.attributes[attribute].array].every(Number.isFinite));
  });
  d.setCutaway(false);
  const roof = d.stats();
  assert.ok(roof.visibleInstances > cut.visibleInstances);
  assert.ok(roof.triangles > cut.triangles);
  assert.equal(roof.meshes, roof.totalMeshes);
  d.setCutaway(true);
  assert.deepEqual(d.stats(), cut);
  d.setNight(true); d.setNight(false);
  assert.equal(JSON.stringify(fixture), before, 'creation and toggles never mutate supplied data');
  let geometryDisposals = 0, materialDisposals = 0;
  for (const g of geometries) g.addEventListener('dispose', () => geometryDisposals++);
  for (const m of materials) m.addEventListener('dispose', () => materialDisposals++);
  d.dispose(); d.dispose();
  assert.equal(geometryDisposals, geometries.size);
  assert.equal(materialDisposals, materials.size);
  assert.equal(d.stats().meshes, 0);
  assert.equal(d.group.children.length, 0);
});

test('furniture clears every authoritative approach and album image opening', needsThree, () => {
  const fixture = buildHouse(), d = make(fixture), data = d.group.userData.diorama;
  for (const object of data.furniture) for (const [id, f] of Object.entries(fixture.home.furniture)) {
    const [x, , z] = f.approach;
    const overlaps = object.min[0] < x + .76 && object.max[0] > x + .24 &&
      object.min[2] < z + .76 && object.max[2] > z + .24 &&
      object.min[1] < 4.75 && object.max[1] > 3.08;
    assert.ok(!overlaps, `${object.id} occupies ${id}'s approach`);
  }
  assert.equal(data.photoFrames.length, 6);
  d.group.updateMatrixWorld(true);
  const rays = new THREE.Raycaster();
  for (let i = 0; i < 6; i++) {
    const position = [36.995, 5.5 - Math.floor(i / 3), 21.5 + i % 3];
    assert.deepEqual(data.photoFrames[i].position, position);
    // The frame can surround, but must not cover any part of the .70 x .92
    // photo aperture from its front. Backing is deliberately behind x=36.995.
    for (const dy of [-.455, 0, .455]) for (const dz of [-.345, 0, .345]) {
      rays.set(new THREE.Vector3(36.8, position[1] + dy, position[2] + dz), new THREE.Vector3(1, 0, 0));
      rays.near = 0; rays.far = .194;
      assert.equal(rays.intersectObject(d.group, true).length, 0, `photo ${i} must stay unobscured`);
    }
  }
  for (const room of fixture.home.rooms.filter(r => r.kind !== 'album')) for (const entrance of room.entrances || []) {
    const [x0, z0, x1, z1] = entrance.rectXZ;
    assert.ok(data.openings.some(o => o.kind === 'door' && o.bottom === 3 && o.top >= 5 &&
      (o.axis === 'x' ? o.start <= x0 && o.end >= x1 && o.fixed >= z0 && o.fixed <= z1
        : o.start <= z0 && o.end >= z1 && o.fixed >= x0 && o.fixed <= x1)), room.id);
  }
  d.dispose();
});

test('block changes remove bespoke furniture, render moved furniture and open actual wall holes', needsThree, () => {
  const fixture = buildHouse();
  const original = make(fixture);
  const at = fixture.home.furniture['adina-bed'].at.join(',');
  const bed = fixture.blocks[at]; delete fixture.blocks[at];
  fixture.blocks['12,4,14'] = bed;
  delete fixture.blocks['25,4,32']; // split the bespoke six-cell dining table
  for (const y of [4, 5, 6]) delete fixture.blocks[`10,${y},9`];
  fixture.blocks['40,2,20'] = 'stone';
  const d = make(fixture), data = d.group.userData.diorama;
  assert.ok(!data.furniture.some(o => o.id === 'adina-bed'));
  const moved = data.furniture.find(o => o.id === 'block:12,4,14');
  assert.ok(moved && moved.min[0] >= 12 && moved.max[0] <= 13 && moved.min[2] >= 14 && moved.max[2] <= 15);
  assert.ok(!data.furniture.some(o => o.id === 'dining-table'));
  assert.ok(!data.furniture.some(o => o.id === 'block:25,4,32'));
  assert.ok(data.furniture.some(o => o.id === 'block:26,4,32'));
  assert.ok(data.furniture.some(o => o.id === 'block:40,2,20'));
  assert.ok(data.openings.some(o => o.axis === 'x' && o.start === 10 && o.end === 11 && o.kind === 'door'));
  const ray = new THREE.Raycaster(new THREE.Vector3(10.5, 4.5, 10.3), new THREE.Vector3(0, 0, -1), 0, 1);
  original.group.updateMatrixWorld(true); d.group.updateMatrixWorld(true);
  assert.ok(ray.intersectObject(original.group, true).length > 0);
  assert.equal(ray.intersectObject(d.group, true).length, 0);
  original.dispose(); d.dispose();
});

test('isolated browser renders the coastal land, cream floor, rooms, gallery and roofs', {
  skip: !threeRoot || !process.env.DIORAMA_SCREENSHOT_DIR, timeout: 60000,
}, async t => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.CHATROOM_PLAYWRIGHT_MODULE || path.join(os.homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  const fixture = buildHouse();
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#e7ece4}canvas{display:block}</style>
    <script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
    <script type="module">
    import * as THREE from 'three'; import {createDiorama} from '/world-diorama.js';
    const f=${JSON.stringify(fixture)};
    const scene=new THREE.Scene(); scene.background=new THREE.Color(0xe7ece4);
    scene.add(new THREE.HemisphereLight(0xfff5df,0xa0b4ac,2.5));
    const sun=new THREE.DirectionalLight(0xffedd3,2.5);sun.position.set(-10,45,22);scene.add(sun);
    const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);
    renderer.setPixelRatio(1);renderer.toneMapping=THREE.ACESFilmicToneMapping;document.body.append(renderer.domElement);
    const camera=new THREE.PerspectiveCamera(35,innerWidth/innerHeight,.1,300);
    const d=createDiorama({THREE,...f});scene.add(d.group);
    window.renderView=(view)=>{d.setCutaway(view!=='roof');
      const views={overview:[[53,47,75],[23.5,2.5,24]],roof:[[53,47,75],[23.5,2.5,24]],
        living:[[28,18,49],[23,3.7,33.5]],bedroom:[[17,12,22],[16,3.7,12.5]],album:[[29,8,22.5],[36,4.7,23]]};
      const [position,target]=views[view];camera.position.set(...position);camera.lookAt(...target);
      renderer.render(scene,camera);return {stats:d.stats(),calls:renderer.info.render.calls,triangles:renderer.info.render.triangles};};
    window.result=window.renderView('overview');
    </script>`;
  const server = http.createServer((req, res) => {
    let body, contentType = 'text/javascript';
    if (req.url === '/') { body = html; contentType = 'text/html'; }
    else if (req.url === '/world-diorama.js') body = source;
    else if (req.url.startsWith('/three/')) {
      const file = path.resolve(threeRoot, req.url.slice(7));
      if (!file.startsWith(path.resolve(threeRoot) + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
      body = fs.readFileSync(file);
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': contentType }); res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHATROOM_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.result);
  fs.mkdirSync(process.env.DIORAMA_SCREENSHOT_DIR, { recursive: true });
  for (const view of ['overview', 'living', 'bedroom', 'album', 'roof']) {
    const result = await page.evaluate(view => window.renderView(view), view);
    assert.ok(result.calls < 60, JSON.stringify(result));
    assert.ok(result.triangles < 80000, JSON.stringify(result));
    await page.screenshot({ path: path.join(process.env.DIORAMA_SCREENSHOT_DIR, `${view}.png`) });
  }
  assert.deepEqual(errors, []);
});
