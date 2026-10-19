import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LiarGame } from '../lib/liar-game.mjs';
import { LiarSession } from '../lib/liar-session.mjs';

function fixture(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, '.liar-session-'));
  t.after(() => fs.rmSync(home, {recursive:true,force:true}));
  let now = 1800000000000, running = true;
  const calls = [], speeches = [], views = [], notices = [];
  const engine = new LiarGame(home, {now, randomInt: () => 0});
  now += 600000;
  const session = new LiarSession(engine, {
    now: () => now, canRun: () => running,
    call: async (actor, card) => { calls.push({actor,card}); return {ok:true,text:JSON.stringify({action:'liar',op:card.phase,text:'그때 쓰면 딱 좋지!'})}; },
    speech: x => speeches.push(x), notice: x => notices.push(x), change: x => views.push(x),
    ...overrides,
  });
  return {session,engine,calls,speeches,views,notices,advance: ms => now += ms,
    stop: () => running = false,
    tick: () => session.tick({running,available:true,busy:session.busy})};
}

test('one reservation at a time; full round uses bounded single calls without vote speech', async t => {
  const f = fixture(t);
  let liar, word;
  f.session.call = async (actor, card) => {
    f.calls.push({actor,card});
    if (card.role === 'liar') liar = actor;
    if (card.word) word = card.word;
    let action = {op:card.phase,text:'유심히 보면 알 것 같네!'};
    if (card.phase === 'vote') action = {op:'vote',target:actor === liar ? card.choices.find(x => x !== actor) : liar};
    if (card.phase === 'guess') action = {op:'guess',text:word};
    return {ok:true,text:JSON.stringify({action:'liar',...action})};
  };
  for (let i=0;i<20;i++) {
    f.tick(); const n = f.calls.length;
    f.tick(); f.tick(); assert.equal(f.calls.length,n);
    await f.session.task;
    if (f.session.view().round?.status === 'finished') break;
    f.advance(12000);
  }
  assert.equal(f.session.view().round.status,'finished');
  assert.equal(f.session.view().round.result.outcome,'liar');
  assert.equal(f.calls.length,13);
  assert.equal(f.speeches.length,8);
  assert.equal(f.calls.filter(x=>x.card.role==='liar').every(x=>!('word' in x.card)),true);
  for (const v of f.views.filter(v=>v.round?.status==='active')) {
    assert.equal(v.round.result,null);
    assert.ok(!JSON.stringify(v).includes('"word"'));
    assert.ok(!JSON.stringify(v).includes('"votes"'));
    if (v.round.phase === 'guess') assert.equal(v.round.turn,null);
  }
});

test('stopped room discards a late answer without any repair or public speech', async t => {
  let done, calls=0;
  const f = fixture(t,{call:()=>{calls++;return new Promise(r=>done=r);}});
  f.tick(); f.stop(); f.tick();
  done({ok:true,text:'{"action":"liar","op":"clue","text":"늦은 말"}'});
  await f.session.task;
  assert.equal(calls,1);assert.equal(f.speeches.length,0);
  assert.equal(f.session.view().round.result.outcome,'cancelled');
});

test('malformed and side effect responses cancel after exactly one repair', async t => {
  let calls = 0;
  const f = fixture(t,{call:async()=>{ calls++; return {ok:true,text:'{"action":"say","messages":["비밀"],"files":[]}'}; }});
  f.tick();await f.session.task;f.advance(50000);f.tick();
  assert.equal(calls,2);
  assert.equal(f.speeches.length,0);assert.equal(f.session.view().round.result.outcome,'cancelled');
});
