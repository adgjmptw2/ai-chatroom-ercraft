import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {LiarGame} from '../lib/liar-game.mjs';
import {serviceFixture} from './helpers/service-fixture.mjs';

const ids=['gpt','gemini','claude','deepseek'];
for(const accept of [true,false]) test(`actual scheduled game invites four resting residents; ${accept?'acceptance':'decline'} changes only appropriate break state`,async t=>{
  let original;
  const f=await serviceFixture(t,{messageCount:0,speed:'fast',
    scriptedReplies:Object.fromEntries(ids.map(id=>[id,[accept?{action:'liar',op:'clue',text:'느낌이 잔잔해요.'}:{action:'liar',op:'decline'}]])),
    prepareHome(home){
      const now=Date.now();
      new LiarGame(home,{now:now-600000+2000});
      const residents=Object.fromEntries(ids.map((id,i)=>[id,{kind:i%2?'rest':'sleep',startedAt:now,until:now+3600000,recent:[]}]));
      original={version:1,residents};
      fs.writeFileSync(path.join(home,'data','state.json'),JSON.stringify({room:{running:true,sleeping:false,speed:'fast',autoSleepMin:0},householdFlow:original}));
    }});
  const sse=await f.openSse();
  await sse.waitFor('liar',x=>x.round?.status==='active');
  const event=await sse.waitFor('liar',x=>accept?x.round?.clues?.length===1:x.round?.status==='finished');
  const metrics=await f.metrics();
  assert.equal(metrics.scriptedCalls.length,1);
  const call=metrics.scriptedCalls[0],card=JSON.parse(call.turn);
  assert.equal(call.opts.game,true);assert.equal(card.currentActivity,original.residents[call.id].kind);
  assert.match(call.brief,/계속 쉴지는 자유/);
  if(!accept)assert.equal(event.data.round.result.outcome,'cancelled');
  await f.shutdown();
  const saved=JSON.parse(fs.readFileSync(path.join(f.data,'state.json'))).householdFlow;
  for(const id of ids)assert.deepEqual(saved.residents[id],accept&&id===call.id?{...original.residents[id],kind:null}:original.residents[id]);
});
