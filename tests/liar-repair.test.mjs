import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LiarGame } from '../lib/liar-game.mjs';
import { LiarSession } from '../lib/liar-session.mjs';
import { buildLiarTurn } from '../lib/liar-turn.mjs';

const flags = {running:true, available:true, busy:false};
const reply = (op, text) => ({ok:true,text:JSON.stringify({action:'liar',op,text})});
function fixture(t, wordId = 0) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, '.liar-repair-'));
  t.after(() => {
    assert.equal(path.dirname(home), import.meta.dirname);
    assert.ok(path.basename(home).startsWith('.liar-repair-'));
    fs.rmSync(home, {recursive:true,force:true});
  });
  let now = 1800000000000;
  const engine = new LiarGame(home, {now:()=>now, randomInt:max=>max > 4 && max < 100 ? wordId : 0});
  now += 600000;
  const f = {engine, home, calls:[], typing:[], speeches:[], diagnostics:[], notices:[], running:true,
    now:()=>now, advance:ms=>now+=ms,
    bytes:()=>fs.readFileSync(path.join(home,'data/liar-game.json'),'utf8')};
  f.session = new LiarSession(engine, {now:f.now,canRun:()=>f.running,
    call:async(actor,card)=>{f.calls.push({actor,card});return f.respond(actor,card);},
    speech:x=>f.speeches.push(x),beforeSubmit:async(actor,text)=>f.typing.push(text),
    notice:x=>f.notices.push(x),change:()=>{},onDiagnostic:x=>f.diagnostics.push(x)});
  f.respond = (actor,card)=>reply(card.phase,'느낌이 잔잔해요.');
  f.tick = async()=>{f.session.tick({...flags,running:f.running});await f.session.task;};
  return f;
}

for(const [wordId,safe,secrets] of [
  [42,['what','모자라다','나는 모자라다','나 는 모자라다','some other words'],['hat','ＨＡＴ','h.a.t','모자','모자는','모 자','혹시 모자인가?','모자네요','털모자 같은 거','hats on','모자라는 물건','모자라고 생각해']],
  [9,['빗나갔다','빗소리','빗물이','combine'],['빗','빗으로','comb','c.o.m.b','빗인가요','combs']],
  [14,['풀어봐','glued'],['풀','풀을','glue']],
  [0,['우리는 산책한다','premium brella','우연히 산다'],['우산','우 - 산','우\u200b산','ＵＭＢＲＥＬＬＡ','u.m b_r-e l l a','우-산','힌트는 우산이에요','우산이었나','우산쓰고','우 산이','umbrellas']],
  [16,['colored people pencil sketches'],['colored pencil','colour pencil','색연필','colored pencils']],
  [28,['frying food','panel'],['frying pan','frying pans','프라이팬인가','후라이팬이네요']],
  [30,['사과하다','사과했어'],['사과요','사과일까','사과하나','사과할까 사과일까','apples']],
]) test(`word ${wordId}: bounded lexical matching retains literal/obfuscated protection`,t=>{
  const f=fixture(t,wordId);f.engine.advance(f.now(),flags);
  assert.equal(JSON.parse(f.bytes()).round.wordId,wordId);
  const ticket=f.engine.pending(f.now()),{token}=f.engine.claim(ticket,f.now());
  for(const text of safe)assert.equal(f.engine.assess(token,ticket.actor,{op:'clue',text},f.now()).reason,'valid',text);
  for(const text of secrets)assert.equal(f.engine.assess(token,ticket.actor,{op:'clue',text},f.now()).reason,'answer_leak',text);
});

test('read-only assessment binds actor/token/time/phase and never mutates private bytes', t=>{
  const f=fixture(t);f.engine.advance(f.now(),flags);
  const ticket=f.engine.pending(f.now()), {token}=f.engine.claim(ticket,f.now()), bytes=f.bytes();
  for (const [tok,actor,action,time,reason] of [
    ['stale',ticket.actor,null,f.now(),'stale'],
    [token,'outsider',null,f.now(),'stale'],
    [token,ticket.actor,null,f.now()-1,'stale'],
    [token,ticket.actor,null,f.now()+180000,'expired'],
    [token,ticket.actor,{op:'vote',target:'adina'},f.now(),'invalid_action'],
    [token,ticket.actor,{op:'clue',text:'우산'},f.now(),'answer_leak'],
    [token,ticket.actor,{op:'decline'},f.now(),'decline'],
    [token,ticket.actor,{op:'clue',text:'느낌이 잔잔해요.'},f.now(),'valid'],
  ]) {assert.equal(f.engine.assess(tok,actor,action,time).reason,reason);assert.equal(f.bytes(),bytes);}
});

test('repair retains the exact claim/card, hides bad text and completes all votes and result', async t=>{
  const f=fixture(t);let liar,word,claim;
  f.respond=(actor,card)=>{
    if(card.role==='liar') liar=actor;
    if(card.word) word=card.word;
    if(f.calls.length===1){claim=JSON.parse(f.bytes()).round.claim;return reply('clue','우산');}
    if(f.calls.length===2){
      assert.deepEqual(JSON.parse(f.bytes()).round.claim,claim);
      const {correction,...original}=card;
      assert.deepEqual(original,f.calls[0].card);
      assert.equal(card.role,'liar');assert.ok(!('word' in card));
      assert.doesNotMatch(correction,/우산|umbrella/);
    }
    // Reproduce a recoverable rejection after six public speeches, in discussion.
    if(card.phase==='discussion' && card.clues.length===6 && !card.correction) return reply('clue','다른 단계의 말');
    if(card.phase==='vote') return {ok:true,text:JSON.stringify({action:'liar',op:'vote',target:actor===liar?card.choices[0]:liar})};
    return reply(card.phase,card.phase==='guess'?word:'느낌이 잔잔해요.');
  };
  for(let i=0;i<13;i++){await f.tick();f.advance(12000);}
  assert.equal(f.calls.length,15);assert.equal(f.typing.length,8);assert.equal(f.speeches.length,8);
  assert.equal(f.session.view().round.result.outcome,'liar');
  assert.deepEqual(f.diagnostics,[{reason:'answer_leak',phase:'clue'},{reason:'invalid_action',phase:'discussion'}]);
  assert.ok(f.typing.every(text=>text!=='우산'));
  assert.ok(f.session.view().round.clues.every(c=>c.text!=='우산'));
});

test('only two repairs per round; third rejected turn cancels without another call', async t=>{
  const f=fixture(t);
  f.respond=(actor,card)=>card.correction?reply(card.phase,'느낌이 잔잔해요.'):reply('vote','bad');
  for(let i=0;i<3;i++){await f.tick();f.advance(12000);}
  assert.equal(f.calls.length,5);assert.equal(f.speeches.length,2);
  assert.equal(f.session.view().round.result.outcome,'cancelled');
  assert.equal(f.session.view().round.result.word,null);
  // A new round receives a fresh budget, without a calendar change.
  f.advance(f.session.view().nextStartAt-f.now());await f.tick();
  assert.equal(f.calls.length,7);assert.equal(f.session.view().round.step,1);
});

for(const mode of ['decline','provider','expired','stop','stale','throw']) test(`${mode} never causes repair`,async t=>{
  const f=fixture(t);
  f.respond=()=>{
    if(mode==='throw') throw new Error('private payload must not escape');
    if(mode==='expired') f.advance(180000);
    if(mode==='stop') f.running=false;
    if(mode==='stale') f.engine.advance(f.now(),{...flags,running:false});
    return mode==='provider'?{ok:false,text:'private'}:mode==='decline'?reply('decline',undefined):reply('clue','우산');
  };
  await f.tick();assert.equal(f.calls.length,1);assert.equal(f.typing.length,0);assert.equal(f.speeches.length,0);
  assert.equal(f.session.view().round.result.outcome,'cancelled');
});

for(const mode of ['invalid','decline','expired','stop','provider']) test(`repair ${mode} safely ends original claim`,async t=>{
  const f=fixture(t);
  f.respond=()=>{
    if(f.calls.length===1)return reply('clue','우산');
    if(mode==='expired')f.advance(180000);
    if(mode==='stop')f.running=false;
    return mode==='provider'?{ok:false}:mode==='decline'?reply('decline',undefined):reply('clue','우산');
  };
  await f.tick();assert.equal(f.calls.length,2);assert.equal(f.typing.length,0);assert.equal(f.speeches.length,0);
  assert.equal(f.session.view().round.result.word,null);
  assert.equal(f.session.view().round.result.outcome,'cancelled');
  assert.doesNotMatch(JSON.stringify(f.notices),/우산|answer_leak|invalid_action/);
});

test('formatter-introduced leak is assessed before typing; pacing expiry cannot publish',async t=>{
  const f=fixture(t);let formatted=0;
  f.session.prepare=()=>++formatted===1?'우산':'느낌이 잔잔해요.';
  f.session.beforeSubmit=async(actor,text)=>{f.typing.push(text);f.advance(180000);};
  await f.tick();assert.equal(f.calls.length,2);assert.deepEqual(f.typing,['느낌이 잔잔해요.']);
  assert.equal(f.speeches.length,0);assert.equal(f.session.view().round.result.outcome,'cancelled');
});

test('restart never redispatches a reserved claim',async t=>{
  const f=fixture(t);f.engine.advance(f.now(),flags);
  f.engine.claim(f.engine.pending(f.now()),f.now());
  const bytes=f.bytes();
  f.session.engine=new LiarGame(f.home,{now:f.now});
  await f.tick();assert.equal(f.calls.length,0);assert.equal(f.bytes(),bytes);
  f.advance(180000);await f.tick();assert.equal(f.calls.length,0);
  assert.equal(f.session.view().round.result.outcome,'cancelled');
});

test('reconstructed session cannot replenish an active round repair budget',async t=>{
  const f=fixture(t);
  await f.tick();f.advance(12000);
  const restored=new LiarGame(f.home,{now:f.now});
  let calls=0;
  const session=new LiarSession(restored,{now:f.now,canRun:()=>true,
    call:async()=>{calls++;return reply('clue','우산');},
    speech:()=>assert.fail('rejected reply published'),notice:()=>{},change:()=>{}});
  session.tick(flags);await session.task;
  assert.equal(calls,1);assert.equal(session.view().round.result.outcome,'cancelled');
});

test('private self-vote is repaired once without sending vote text to typing or speech',async t=>{
  const f=fixture(t);
  for(let i=0;i<8;i++){await f.tick();f.advance(12000);}
  f.respond=(actor,card)=>({ok:true,text:JSON.stringify({action:'liar',op:'vote',target:card.correction?card.choices[0]:actor})});
  await f.tick();
  assert.equal(f.calls.length,10);assert.equal(f.typing.length,8);assert.equal(f.speeches.length,8);
  assert.equal(f.session.view().round.step,9);
  assert.deepEqual(f.diagnostics,[{reason:'invalid_action',phase:'vote'}]);
});

test('each brief has only a concrete current-phase template and repair contains no rejected text',()=>{
  for(const phase of ['clue','discussion','vote','guess']){
    const card={actor:'bianca',phase,choices:['adina','eleven','lucia'],role:'liar'};
    const {brief}=buildLiarTurn('claude',card);
    const objects=[...brief.matchAll(/\{"action":"liar"[^\n]*?\}/g)].map(m=>JSON.parse(m[0]));
    assert.deepEqual(objects.map(x=>x.op),[phase,'decline']);
    if(phase==='vote')assert.ok(card.choices.includes(objects[0].target));
    assert.doesNotMatch(brief,/clue 또는 discussion|이번 차례의 힌트를/);
  }
});
