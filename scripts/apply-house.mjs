// Explicit offline migration. Never called by server startup.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildHouse, HOUSE_VERSION } from '../lib/house.mjs';
import { World } from '../lib/world.mjs';
import { PlanBook } from '../lib/plans.mjs';
import { AI_IDS } from '../lib/members.mjs';
const root=path.resolve(import.meta.dirname,'..');
if(process.argv[2]!=='--apply') throw Error('Use node scripts/apply-house.mjs --apply after stopping this server.');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
const port=cfg.port||8321;
for(const host of ['127.0.0.1','::1']) await new Promise((resolve,reject)=>{
  const socket=net.createConnection({host,port});
  socket.setTimeout(1500);
  socket.once('connect',()=>{socket.destroy();reject(Error(`Stop the listener on ${port} before applying the house.`));});
  socket.once('timeout',()=>{socket.destroy();reject(Error('Could not verify the server is stopped.'));});
  socket.once('error',e=>e.code==='ECONNREFUSED'?resolve():reject(e));
});
const pidFile=path.join(root,'data/server.pid');
if(fs.existsSync(pidFile)) {
  const pid=Number(fs.readFileSync(pidFile,'utf8').trim());
  if(!Number.isSafeInteger(pid)||pid<=0) throw Error('Invalid recorded server identity.');
  let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
  if(alive)throw Error('Recorded server is still running.');
}
const roomState=JSON.parse(fs.readFileSync(path.join(root,'data/state.json'),'utf8'));
if(roomState.room?.running!==false)throw Error('Stop the room before replacement.');
const worldFile=path.join(root,'data/world.json'),plansFile=path.join(root,'data/world-plans.json');
for(const file of [worldFile,plansFile]) if(fs.existsSync(file)) {
  for(let p=file;p!==root;p=path.dirname(p))if(fs.lstatSync(p).isSymbolicLink())throw Error('Linked runtime path cannot be replaced.');
  if(fs.statSync(file).nlink!==1)throw Error('Shared runtime file cannot be replaced.');
}
const oldWorld=JSON.parse(fs.readFileSync(worldFile,'utf8'));
if(oldWorld.home?.fixtureVersion===HOUSE_VERSION) throw Error('This house version is already installed; refusing to reset its current life.');
const oldPlans=fs.existsSync(plansFile)?JSON.parse(fs.readFileSync(plansFile,'utf8')):null;
if(oldPlans?.inflight || oldPlans?.attempts?.some(a=>a.status==='pending')) throw Error('Unresolved design work must settle before replacement.');
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const receiptPath=path.join(root,'data/model-privacy-runtime.json');
const protectedFiles=fs.existsSync(receiptPath)?Object.keys(JSON.parse(fs.readFileSync(receiptPath,'utf8')).hashes):['config.json','data/state.json'];
const protectedBefore=Object.fromEntries(protectedFiles.filter(p=>!['data/world.json','data/world-plans.json'].includes(p)).map(p=>[p,hash(path.join(root,p))]));
const backup=path.join(os.homedir(),'Documents/Codex/ERCraft-backups',`house-live-${Date.now()}`);
fs.mkdirSync(backup,{recursive:true});
for(const f of [worldFile,plansFile]) if(fs.existsSync(f)) fs.copyFileSync(f,path.join(backup,path.basename(f)),fs.constants.COPYFILE_EXCL);
const replacement=buildHouse();const world=new World(root,AI_IDS);
const plans=new PlanBook(root,cfg,world,()=>{throw Error('Offline migration cannot call the planner.');});
const cancelled=[];const temporary=`${worldFile}.house-${process.pid}.tmp`;
try {
  for(const p of oldPlans?.plans||[]) if(!['complete','cancelled','failed'].includes(p.status)) {plans.cancel(p.id,p.owner);cancelled.push(p.id);}
  fs.writeFileSync(temporary,JSON.stringify(replacement),{flag:'wx'});fs.renameSync(temporary,worldFile);
  const check=new World(root,AI_IDS);
  if(check.home?.id!=='mulgyeol-maru'||check.blocks.size!==Object.keys(replacement.blocks).length) throw Error('Installed world validation failed.');
  for(const [p,h] of Object.entries(protectedBefore)) if(hash(path.join(root,p))!==h) throw Error(`Unrelated runtime file changed: ${p}`);
  const report={status:'applied',version:HOUSE_VERSION,backup,blocks:check.blocks.size,cancelledOldPlans:cancelled.length,preservedFiles:Object.keys(protectedBefore).length,worldSha256:hash(worldFile)};
  fs.writeFileSync(path.join(backup,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(e) {
  for(const f of [worldFile,plansFile]) {const saved=path.join(backup,path.basename(f));if(fs.existsSync(saved))fs.copyFileSync(saved,f);}
  if(fs.existsSync(temporary))fs.unlinkSync(temporary);
  throw e;
} finally {clearTimeout(world.saveTimer);}
