import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {serviceFixture} from './helpers/service-fixture.mjs';

test('actual server returns 80 recent messages and reversible 60-message history pages without changing the archive', {timeout:30000},async t=>{
 const f=await serviceFixture(t,{messageCount:1000,gateway:true});
 const log=f.data+'/messages.jsonl',before=fs.readFileSync(log);
 const state=(await f.request('/chat/api/state')).json;
 assert.equal(state.messages.length,80);
 assert.equal(state.messages[0].id,921);assert.equal(state.messages.at(-1).id,1000);
 assert.deepEqual(state.session,{role:'viewer',authenticated:false});
 assert.equal((await f.request('/chat/timeline-window.js')).status,200);
 const ids=state.messages.map(m=>m.id);let cursor=ids[0];
 while(cursor>1){
  const res=await f.request('/chat/api/history?before='+cursor+'&limit=60');
  assert.equal(res.status,200);const page=res.json.messages;
  assert.ok(page.length>0&&page.length<=60);assert.ok(page.every(m=>m.id<cursor));
  assert.doesNotMatch(JSON.stringify(page),/fixture-private-model|fixture-provider-private|remainingPct|1357911/);
  ids.unshift(...page.map(m=>m.id));cursor=page[0].id;
 }
 assert.deepEqual(ids,Array.from({length:1000},(_,i)=>i+1));
 assert.deepEqual((await f.request('/chat/api/history?before=1')).json.messages,[]);
 for(const suffix of ['', '&limit=bad','&limit=-4','&limit=0']){
  assert.equal((await f.request('/chat/api/history?before=921'+suffix)).json.messages.length,60);
 }
 assert.equal((await f.request('/chat/api/history?before=921&limit=9999')).json.messages.length,200);
 const oldest=(await f.request('/chat/api/history?before=4&limit=2')).json.messages;
 assert.deepEqual(oldest.map(m=>m.id),[2,3]);
 assert.deepEqual(oldest[0].reactions,{'🌷':['eleven']});
 assert.equal(oldest[0].attach.desc,'뒤늦은 설명 🐱');
 assert.equal((await f.request('/chat/api/admin/raw/state')).status,401);
 assert.equal((await f.request('/chat/api/state',{headers:{Host:'api.ercraft.net'}})).status,404);
 assert.deepEqual(fs.readFileSync(log),before);
 const metrics=await f.metrics();assert.deepEqual(metrics.violations,[]);assert.deepEqual(metrics.scriptedCalls,[]);
});
