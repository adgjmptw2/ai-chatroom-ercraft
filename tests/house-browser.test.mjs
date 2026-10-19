// Synthetic isolated world: no production data, no model calls, no runtime mutations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import { buildHouse } from '../lib/house.mjs';
import { World } from '../lib/world.mjs';
import { AI_IDS, MEMBERS } from '../lib/members.mjs';
import { publicMember } from '../lib/public-view.mjs';
import { defaultPublicIdentity as privacy, publicId, resolveCharacterAsset } from '../lib/public-identity.mjs';
const root=path.resolve(import.meta.dirname,'..');
const require=createRequire(import.meta.url);
let chromium;
for (const name of [process.env.CHATROOM_PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { ({chromium}=require(name)); break; } catch { /* optional browser runtime */ }
}
const browserPath=process.env.CHATROOM_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium?.executablePath()].filter(Boolean).find(fs.existsSync);
const threeRoot=process.env.CHATROOM_THREE_ROOT;

test('house cameras, indoor movement and idle rendering stay bounded', {timeout:60000, skip: (!chromium || !browserPath || !threeRoot) && 'Set CHATROOM_THREE_ROOT and use an installed Playwright/browser'}, async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ercraft-house-browser-'));
  fs.mkdirSync(path.join(home,'data'));fs.writeFileSync(path.join(home,'data/world.json'),JSON.stringify(buildHouse()));
  const world=new World(home,AI_IDS);const clients=new Set();
  const state={room:{running:false,sleeping:true,userName:'ERCraft'},members:AI_IDS.map(id=>publicMember({id,...MEMBERS[id],status:'sleeping',enabled:true})),messages:[],files:[]};
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': fixture\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
    if(['/api/state','/api/world'].includes(url.pathname)){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(url.pathname.endsWith('world')?privacy.world(world.view()):state));return;}
    const asset=resolveCharacterAsset(url.pathname);
    const previewHtml=url.pathname==='/world.html' && process.env.ERCRAFT_HOUSE_HTML;
    const f=previewHtml ? path.resolve(process.env.ERCRAFT_HOUSE_HTML) : asset ? path.join(root,'public',asset) : path.resolve(root,'public','.'+url.pathname);
    if((!previewHtml&&!f.startsWith(path.join(root,'public')+path.sep))||!fs.existsSync(f)){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.png':'image/png'})[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:browserPath,args:['--enable-unsafe-swiftshader']});
  t.after(async()=>{clearTimeout(world.saveTimer);await browser.close();for(const c of clients)c.end();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**/*',async route=>{
    const prefix='https://cdn.jsdelivr.net/npm/three@0.170.0/';const u=route.request().url();
    if(threeRoot&&u.startsWith(prefix)) {const file=path.resolve(threeRoot,u.slice(prefix.length));if(file.startsWith(path.resolve(threeRoot)+path.sep)&&fs.existsSync(file))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(file)});}
    if(u.startsWith(prefix))return route.continue();return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/world.html`);
  await page.waitForFunction(()=>window.__worldRenderStats?.().blocks===5080 && document.querySelector('#world-title').textContent==='물결마루');
  await page.waitForFunction(()=>{
    const frames=[...document.querySelectorAll('#who .persona-avatar')];
    return frames.length===4 && frames.every(frame=>frame.querySelector('img')?.dataset.sharedState==='ready'
      || frame.querySelector('.persona-avatar-initial') && getComputedStyle(frame.querySelector('.persona-avatar-initial')).visibility==='visible');
  });
  await page.waitForTimeout(600);
  const initial=await page.evaluate(()=>window.__worldRenderStats());
  const out=process.env.ERCRAFT_HOUSE_SCREENSHOT_DIR;
  if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'initial.png')});fs.writeFileSync(path.join(out,'initial-metrics.json'),JSON.stringify(initial,null,2));}
  assert.equal(initial.passes,1);assert.ok(initial.visibleInstances<initial.blocks*0.5);assert.ok(initial.pixelRatio<=1.25);
  assert.equal(initial.style,'diorama');
  assert.equal(initial.blockDrawCalls,0,'the home does not render voxel batches');
  assert.ok(initial.calls<100,'furniture is batched with a bounded draw budget');
  assert.ok(initial.triangles<100000,`detailed furniture stays within the low-poly budget: ${initial.triangles}`);
  assert.equal(await page.locator('#scene canvas').count(),1);
  await page.waitForTimeout(650);
  assert.equal((await page.evaluate(()=>window.__worldRenderStats())).renderedFrames,initial.renderedFrames,'stationary scene does not redraw');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));document.querySelector('[data-camera="living"]').click();});
  await page.waitForTimeout(200);
  assert.equal((await page.evaluate(()=>window.__worldRenderStats())).renderedFrames,initial.renderedFrames,'hidden scene does not draw even after camera input');
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));document.querySelector('[data-camera="overview"]').click();});
  await page.waitForTimeout(350);
  if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'overview.png')});}
  const cameras={};
  for(const id of ['living','courtyard','album','overview']){
    await page.locator(`[data-camera="${id}"]`).click();await page.waitForTimeout(350);
    cameras[id]=await page.evaluate(()=>window.__worldRenderStats());assert.equal(cameras[id].camera,id);
    if(out)await page.screenshot({path:path.join(out,`${id}.png`)});
  }
  await page.locator('[data-camera="living"]').click();
  for(const c of clients)c.end();
  await page.waitForTimeout(3700);
  assert.equal((await page.evaluate(()=>window.__worldRenderStats())).camera,'living','reconnection preserves the selected camera');
  for(const c of clients)c.write(`event: signs\ndata: ${JSON.stringify({'15,5,30':{text:'오늘의 메뉴',width:2,facing:'s',bg:'#526f6b',color:'#fff2d7'}})}\n\n`);
  await page.waitForFunction(()=>window.__worldRenderStats().visibleSigns===1);
  for(const c of clients)c.write('event: signs\ndata: {}\n\n');
  await page.waitForFunction(()=>window.__worldRenderStats().visibleSigns===0);
  await page.locator('#cutaway').click();await page.waitForTimeout(350);
  const roof=await page.evaluate(()=>window.__worldRenderStats());assert.equal(roof.cutaway,false);assert.ok(roof.visibleInstances>initial.visibleInstances);
  await page.locator('#cutaway').click();await page.waitForTimeout(350);
  assert.equal((await page.evaluate(()=>window.__worldRenderStats())).visibleInstances,initial.visibleInstances);
  const beforeToggles=await page.evaluate(()=>window.__worldRenderStats());
  for(let i=0;i<6;i++){await page.locator('#cutaway').click();await page.waitForTimeout(50);}
  await page.waitForTimeout(200);
  const afterToggles=await page.evaluate(()=>window.__worldRenderStats());
  assert.equal(afterToggles.geometries,beforeToggles.geometries,'roof toggles reuse geometry');
  assert.equal(afterToggles.textures,beforeToggles.textures,'roof toggles reuse textures');
  await page.locator('#night').click();await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'dark');
  await page.locator('#night').click();await page.waitForTimeout(150);
  const spinStart=await page.evaluate(()=>({at:performance.now(),frames:window.__worldRenderStats().renderedFrames}));
  await page.locator('#rotate').click();await page.waitForTimeout(1800);
  const spinEnd=await page.evaluate(()=>({at:performance.now(),frames:window.__worldRenderStats().renderedFrames}));
  await page.locator('#rotate').click();await page.waitForTimeout(500);
  const activeFps=(spinEnd.frames-spinStart.frames)*1000/(spinEnd.at-spinStart.at);
  assert.ok(activeFps>0&&activeFps<=33,'active rendering remains capped near 30 fps');
  const settled=await page.evaluate(()=>window.__worldRenderStats().renderedFrames);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>window.__worldRenderStats().renderedFrames),settled,'camera rotation stops scheduling frames');
  assert.equal(world.move('gpt',[16,31]),true);
  const movement=privacy.project(world.avatarView());
  for(const c of clients)c.write(`event: avatars\ndata: ${JSON.stringify(movement)}\n\n`);
  await page.waitForFunction(()=>window.__worldRenderStats().actors.adina.remaining>0);
  await page.waitForFunction(()=>window.__worldRenderStats().actors.adina.remaining===0);
  const end=await page.evaluate(()=>window.__worldRenderStats().actors.adina.position);
  assert.deepEqual(end,[16.5,3,31.5]);
  await page.waitForTimeout(300);const beforeReplay=await page.evaluate(()=>window.__worldRenderStats().actors.adina.position);
  for(const c of clients)c.write(`event: avatars\ndata: ${JSON.stringify(movement)}\n\n`);
  await page.waitForTimeout(100);assert.deepEqual(await page.evaluate(()=>window.__worldRenderStats().actors.adina.position),beforeReplay);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(out)await page.screenshot({path:path.join(out,'mobile.png')});
  assert.deepEqual(errors,[]);
  if(out)fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify({initial,cameras,roof,activeFps,errors},null,2));
});
