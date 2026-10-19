import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LiarGame } from '../lib/liar-game.mjs';
import { serviceFixture } from './helpers/service-fixture.mjs';

test('public upcoming schedule is available through state/SSE, private file and writes remain closed', async t => {
  const f=await serviceFixture(t,{messageCount:90});
  const state=(await f.request('/chat/api/state')).json;
  assert.equal(state.liar.version,1);assert.equal(state.liar.round,null);
  assert.ok(state.liar.nextStartAt-Date.now() > 590000);
  assert.equal(state.liar.nextStartAt-state.liar.noticeAt,600000);
  const sse=await f.openSse();
  assert.equal((await sse.waitFor('liar')).data.nextStartAt,state.liar.nextStartAt);
  assert.equal((await f.request('/chat/api/liar')).json.nextStartAt,state.liar.nextStartAt);
  assert.equal((await f.request('/chat/liar-panel.js')).status,200);
  assert.equal((await f.request('/chat/data/liar-game.json')).status,404);
  assert.equal((await f.request('/chat/api/liar',{method:'POST',origin:f.origin,body:{op:'start'}})).status,401);
  assert.equal((await f.metrics()).scriptedCalls.length,0);
});

test('actual scheduler runs only the designated actor with a private compact card and publishes validated clue', async t => {
  const actorMap={adina:'gpt',bianca:'gemini',eleven:'claude',lucia:'deepseek'};
  const reply='{"action":"liar","op":"clue","text":"한 번 쓰면 편리해!"}';
  let actor;
  const f=await serviceFixture(t,{messageCount:0,speed:'fast',
    scriptedReplies:Object.fromEntries(Object.values(actorMap).map(id=>[id,[reply]])),
    prepareHome(home) {
      const now=Date.now(),g=new LiarGame(home,{now:now-600000,randomInt:()=>0});
      g.advance(now,{running:true,available:true,busy:false});actor=g.view(now).round.turn;
      fs.writeFileSync(path.join(home,'data','state.json'),JSON.stringify({room:{running:true,sleeping:false,autoSleepMin:0,speed:'fast'}}));
    },
  });
  const sse=await f.openSse();
  const event=await sse.waitFor('liar',x=>x.round?.clues?.length===1);
  assert.equal(event.data.round.clues[0].actor,actor);
  assert.equal(event.data.round.result,null);
  const metrics=await f.metrics();
  assert.equal(metrics.scriptedCalls.length,1);
  const call=metrics.scriptedCalls[0];assert.equal(call.id,actorMap[actor]);
  assert.equal(call.opts.game,true);assert.equal(call.opts.boost,false);assert.deepEqual(call.opts.images,[]);
  const card=JSON.parse(call.turn);assert.equal(card.actor,actor);assert.equal(card.phase,'clue');
  assert.ok(call.brief.length+call.turn.length<11000);
  const state=(await f.request('/chat/api/state')).json;
  assert.ok(state.messages.some(x=>x.from===actor&&x.text));
  assert.doesNotMatch(JSON.stringify(state.liar),/"role"|"word"|"votes"|"claim"/);
});

test('guessing stage never identifies the liar through public turn or member typing states', async t => {
  const actorMap={adina:'gpt',bianca:'gemini',eleven:'claude',lucia:'deepseek'};
  const reply='{"action":"liar","op":"guess","text":"다른 단어"}';
  const f=await serviceFixture(t,{messageCount:0,
    scriptedReplies:Object.fromEntries(Object.values(actorMap).map(id=>[id,[reply]])),
    prepareHome(home) {
      const now=Date.now(); let at=now-160000;
      const g=new LiarGame(home,{now:at-600000,randomInt:()=>0});
      g.advance(at,{running:true,available:true,busy:false});
      const players=g.view(at).round.players,liar=players[0];
      for(let i=0;i<12;i++) {
        const ticket=g.pending(at),{token}=g.claim(ticket,at);
        const action=i<8?{op:ticket.phase,text:'꽤 편리한 느낌이야!'}:{op:'vote',target:ticket.actor===liar?players[1]:liar};
        assert.equal(g.submit(token,ticket.actor,action,at).ok,true);at+=12000;
      }
      assert.equal(g.view(at).round.phase,'guess');
      fs.writeFileSync(path.join(home,'data','state.json'),JSON.stringify({room:{running:true,sleeping:false,autoSleepMin:0}}));
    },
  });
  const initial=(await f.request('/chat/api/state')).json;
  assert.equal(initial.liar.round.phase,'guess');assert.equal(initial.liar.round.turn,null);
  const sse=await f.openSse();
  await sse.waitFor('liar',x=>x.round?.status==='finished');
  const firstMembers=sse.events.find(x=>x.type==='members');
  assert.ok(firstMembers);
  assert.ok(firstMembers.data.every(m=>!['reading','typing'].includes(m.status)));
  const state=(await f.request('/chat/api/state')).json;
  assert.equal(state.liar.round.result.outcome,'citizens');
  assert.ok(state.messages.some(m=>m.text.includes('제시어는')));
});
