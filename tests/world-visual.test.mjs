// Isolated visual fixture: node tests/world-visual.test.mjs --preview
// Serves only public assets and synthetic state on a random loopback port.
// ?scene=materials&baseline=1 compares tracked renderer with the same cells;
// ?scene=furniture shows every new shape and sit/lie/work postures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { World, parseBlock } from '../lib/world.mjs';
import { isFurniture, furnitureBatch } from '../public/world-materials.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export function referenceCells(furniture = false) {
  const blocks = new Map();
  const set = (x, y, z, b) => blocks.set(`${x},${y},${z}`, [x, y, z, b]);
  for (let x = 12; x <= 22; x++) for (let z = 12; z <= 20; z++) set(x, 1, z, 'planks');
  for (let x = 12; x <= 22; x++) for (let y = 2; y <= 4; y++) set(x, y, 12, 'brick');
  for (let z = 13; z <= 20; z++) for (let y = 2; y <= 3; y++) set(12, y, z, 'stone');
  for (const x of [14, 15, 19, 20]) set(x, 2, 13, 'bookshelf');
  for (const x of [14, 20]) set(x, 4, 12, 'lamp');
  for (let z = 13; z <= 16; z++) set(22, 2, z, 'glass');
  if (furniture) {
    for (const [x, z, shape, facing] of [[15, 16, 'chair', 's'], [17, 16, 'table', 'n'], [20, 16, 'bench', 'w'], [14, 19, 'bed', 'n'], [20, 19, 'workbench', 'e']]) set(x, 2, z, `planks/${shape}/${facing}`);
  } else {
    for (const [i, material] of ['white', 'cobble', 'sand', 'log', 'leaves', 'gold', 'purple'].entries()) set(14 + i, 2, 17, material);
  }
  return [...blocks.values()];
}

test('fixed reference preserves cube triangle count and reduces bookshelf draw groups', () => {
  const cells = referenceCells();
  const batches = new Set(cells.map(([, , , b]) => b));
  const before = [...batches].reduce((n, b) => n + (b === 'bookshelf' ? 6 : 1), 0);
  const after = batches.size;
  assert.equal(cells.length, 163);
  assert.equal(before, 18);
  assert.equal(after, 13);
  assert.equal(cells.length * 12, 1956);
});

test('four facing variants of every furniture shape still need only five batches', () => {
  const cells = ['chair', 'table', 'bench', 'bed', 'workbench'].flatMap((s) => ['n', 'e', 's', 'w'].flatMap((f) => Array(50).fill(`planks/${s}/${f}`)));
  const batches = new Set(cells.map((b) => { const p = parseBlock(b); return isFurniture(p.shape) ? furnitureBatch(p.type, p.shape) : b; }));
  assert.equal(cells.length, 1000);
  assert.equal(batches.size, 5);
});

if (process.argv.includes('--preview')) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-visual-'));
  fs.mkdirSync(path.join(home, 'data'));
  const views = {};
  for (const scene of ['materials', 'furniture']) {
    const w = new World(home, ['gpt', 'claude', 'gemini', 'deepseek', 'dev']);
    w.blocks = new Map(referenceCells(scene === 'furniture').map(([x, y, z, b]) => [`${x},${y},${z}`, b]));
    w.avatars = {};
    if (scene === 'furniture') {
      w.avatars = { gpt: { x: 14, y: 2, z: 18 }, claude: { x: 16, y: 2, z: 18 }, gemini: { x: 18, y: 2, z: 18 }, deepseek: { x: 20, y: 2, z: 18 }, dev: { x: 21, y: 2, z: 18 } };
      w.useFurniture('gpt', [15, 2, 16]); w.useFurniture('claude', [14, 2, 19]); w.useFurniture('gemini', [17, 2, 16]);
      clearTimeout(w.saveTimer);
    }
    views[scene] = w.view();
  }
  const names = { gpt: ['Bianca', '#d3ac42'], claude: ['Eleven', '#ec7fa9'], gemini: ['Lucia', '#7974c5'], deepseek: ['Adina', '#669b77'], dev: ['Nadja', '#4b8986'] };
  const state = { room: { userName: 'Preview' }, messages: [], members: Object.entries(names).map(([id, [name, color]]) => ({ id, name, color, persona: { skin: { avatar: `/assets/characters/${id}/avatar.png` } } })) };
  const baseline = execFileSync('git', ['show', 'HEAD:public/world.html'], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const reports = new Map();
  const diagnostics = `
    window.__worldRenderStats ??= () => ({blocks:blocks.size,batches:meshes.size,blockDrawCalls:[...meshes.values()].reduce((n,m)=>n+(Array.isArray(m.material)?m.geometry.groups.length:1),0),blockTriangles:[...meshes.values()].reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3*m.count,0),geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,lights:scene.children.filter(o=>o.isLight).length,passes:composer.passes.length});
    renderer.info.autoReset=false;
    const report=document.createElement('pre');report.id='visual-report';report.style='position:fixed;left:8px;bottom:8px;max-width:96vw;margin:0;padding:8px;background:#ffffffdf;color:#152329;font:12px monospace;pointer-events:none';document.body.append(report);
    const durations=[];let last=0,frames=0,first=null;
    function collect(now){
      if(window.__shotReady){
        if(last)durations.push(now-last);last=now;frames++;
        if(frames===30)first=window.__worldRenderStats();
        if(frames===180){const stats=window.__worldRenderStats(),sorted=durations.slice().sort((a,b)=>a-b);const result={scene:new URLSearchParams(location.search).get('scene')||'furniture',baseline:new URLSearchParams(location.search).has('baseline'),stats,first,meanFrameMs:durations.reduce((a,b)=>a+b,0)/durations.length,p95FrameMs:sorted[Math.floor(sorted.length*.95)]};report.textContent=JSON.stringify(result);fetch('/_metrics',{method:'POST',body:JSON.stringify(result)});return;}
      }
      requestAnimationFrame(collect);
    }
    addEventListener('error',e=>{report.textContent='ERROR '+e.message;fetch('/_metrics',{method:'POST',body:JSON.stringify({error:e.message})});});
    requestAnimationFrame(collect);
  `;
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'), ref = new URL(req.headers.referer || '/', 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/world' || url.pathname === '/api/state') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(url.pathname === '/api/state' ? state : views[ref.searchParams.get('scene') || 'furniture'])); return;
    }
    if (url.pathname === '/_metrics') {
      if (req.method === 'POST') { let body = ''; req.on('data', (c) => body += c); req.on('end', () => { try { const v = JSON.parse(body); reports.set(`${v.scene}/${v.baseline}`, v); } catch {} res.end('ok'); }); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([...reports.values()])); } return;
    }
    if (url.pathname === '/world.html' || url.pathname === '/') {
      let html = url.searchParams.has('baseline') ? baseline : fs.readFileSync(path.join(root, 'public/world.html'), 'utf8');
      html = html.replace('renderWho();\napplyNight();', `${diagnostics}\nrenderWho();\napplyNight();`).replace('renderWho();\r\napplyNight();', `${diagnostics}\nrenderWho();\napplyNight();`);
      if (url.searchParams.has('baseline')) html = html.replace('  composer.render();', '  renderer.info.reset(); composer.render();');
      res.setHeader('Content-Type', 'text/html'); res.end(html); return;
    }
    const file = path.resolve(root, 'public', '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(path.resolve(root, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => console.log(`VISUAL_PREVIEW http://127.0.0.1:${server.address().port}/world.html?shot=1&scene=furniture&tx=17&tz=16&dist=17&angle=30&elev=35&night=0`));
  const close = () => { server.close(); fs.rmSync(home, { recursive: true, force: true }); process.exit(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
