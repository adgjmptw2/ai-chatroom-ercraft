import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {HouseholdFlow,restIntent,leisureRequest,enterLeisure,busyHousehold} from '../lib/household-flow.mjs';
import {RoomRhythm,repeatedConversation,walkDestination} from '../lib/room-rhythm.mjs';
import {World} from '../lib/world.mjs';
import {buildHouse} from '../lib/house.mjs';
import {parseAction} from '../lib/prompt.mjs';
const IDS=['claude','gpt','deepseek','gemini'],NOW=Date.UTC(2026,9,3),M=60000;
function fixture(t){
  const parent=import.meta.dirname,root=fs.mkdtempSync(path.join(parent,'.household-fixture-'));
  t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(parent));assert.ok(path.basename(root).startsWith('.household-fixture-'));fs.rmSync(root,{recursive:true});});
  fs.mkdirSync(root+'/data');fs.writeFileSync(root+'/data/world.json',JSON.stringify(buildHouse()));
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const world=new World(root,IDS);t.mock.method(world,'save',()=>{});
  return {world,time:n=>{now=n;}};
}
test('only immediate self commitments trigger rest, not greetings, quotations, questions or tomorrow',()=>{
  for(const s of ['나도 이제 진짜 잘게! 잘 자!','이번엔 정말 눈 감는답니다.','오늘은 진짜 자야겠다, 잘 자!','소녀도 이제 눈 감겠어요.'])assert.equal(restIntent(s),'sleep',s);
  for(const s of ['나는 잠깐 쉬고 올게!','소녀도 이제 정말 조용히 있겠어요.'])assert.equal(restIntent(s),'rest',s);
  for(const s of ['잘 자, 루치아!','나는 안 자고 글 쓸래.','나도 내일 잘게.','이제 자야 하는 거 아니야?','비앙카가 “나도 이제 잘게”라고 했어.','나는 오늘 잠이 안 와','이제 숙제를 끝내야지','일레븐, 이번엔 잘 자.',
    '나는 이제 안 잘래.','나도 오늘은 못 잘게.','나도 이야기가 끝나면 잘게!','소녀도 그림을 그리고 나서 잠들겠어요.','이제 ‘나도 잘게’라는 대사를 읽어볼까.'])assert.equal(restIntent(s),null,s);
});
test('sleep blocks peer replies and autonomous turns, host can wake, restart preserves the commitment',()=>{
  const flow=new HouseholdFlow();flow.start('claude',{kind:'sleep',minutes:40},NOW);
  const rebuilt=new HouseholdFlow(flow.snapshot());
  assert.equal(rebuilt.blocks('claude',{peerCalled:true,now:NOW+M}),true);
  assert.equal(rebuilt.blocks('claude',{directHost:true,now:NOW+M}),false);
  assert.equal(rebuilt.phase('gpt',NOW+M),null);assert.equal(rebuilt.phase('claude',NOW+39*M),'sleep');
  assert.equal(rebuilt.interrupt('claude'),true);assert.equal(rebuilt.phase('claude',NOW+M),null);
  assert.equal(flow.phase('claude',NOW+M),'sleep','snapshots are independent');
});
test('focused hobbies allow a named peer after two minutes, expire without becoming a permanent lock',()=>{
  const f=new HouseholdFlow();f.start('gpt',{kind:'write',minutes:6},NOW);
  assert.equal(f.blocks('gpt',{peerCalled:true,now:NOW+M}),true);
  assert.equal(f.blocks('gpt',{peerCalled:true,now:NOW+3*M}),false);
  assert.equal(f.blocks('gpt',{now:NOW+3*M}),true);
  assert.equal(f.expire(NOW+6*M),true);assert.equal(f.phase('gpt',NOW+6*M),null);assert.equal(f.expire(NOW+7*M),false);
});
test('bounded protocol and stored state reject corrupt inputs and recognize action-only leisure JSON',()=>{
  assert.deepEqual(leisureRequest({kind:'sleep',minutes:999}),{kind:'sleep',minutes:60});
  for(const v of [null,[],{kind:'__proto__'},{kind:'sleep',minutes:-1},{kind:'write',minutes:'10'}])assert.equal(leisureRequest(v),null);
  assert.deepEqual(parseAction('{"leisure":{"kind":"write"}}'),{leisure:{kind:'write'}});
  assert.throws(()=>new HouseholdFlow({version:2,residents:{}}));
  assert.throws(()=>new HouseholdFlow({version:1,residents:{gpt:{kind:'sleep',startedAt:NOW,until:NOW+999*M,recent:[]}}}));
});
test('activity suggestions rotate away from recent dominant hobbies and do not intrude on host or active work',()=>{
  const f=new HouseholdFlow();for(let n=0;n<8;n++)f.start('gpt',{kind:'write'},NOW+n*M);
  assert.equal(f.snapshot().residents.gpt.recent.length,6);
  assert.equal(f.offer('gpt',{now:NOW+8*M}), '');
  assert.equal(f.offer('gpt',{now:NOW+20*M,hostPending:true}), '');
  const cue=f.offer('gpt',{now:NOW+20*M});assert.ok(cue);assert.doesNotMatch(cue,/"kind":"write"/);
  assert.match(cue,/잡담·pass/);assert.equal(f.offer('gemini',{now:NOW+21*M}), '');
  assert.ok(f.offer('gemini',{now:NOW+24*M}));
});
test('all eight leisure choices use real reachable furniture/routes without changing the house or other residents',t=>{
  const f=fixture(t),before=JSON.stringify([...f.world.blocks]),others=JSON.stringify(Object.fromEntries(IDS.filter(i=>i!=='gpt').map(i=>[i,f.world.avatars[i]])));
  let now=NOW;
  for(const kind of ['write','draw','read','music','tidy','rest','sleep','walk']){
    f.time(now);assert.equal(enterLeisure(f.world,'gpt',kind,{now}).ok,true,kind);now+=M;
  }
  assert.equal(JSON.stringify([...f.world.blocks]),before);
  assert.equal(JSON.stringify(Object.fromEntries(IDS.filter(i=>i!=='gpt').map(i=>[i,f.world.avatars[i]]))),others);
  assert.equal(f.world.avatars.gpt.posture,'stand');
});
test('cooking, games, unavailable household and moving avatars cannot be interrupted by a leisure move',t=>{
  const f=fixture(t),before=JSON.stringify(f.world.avatars);
  for(const living of [{unavailable:true},{pausedAt:NOW},{meal:{status:'cooking',cook:'gpt'}},{game:{status:'playing',players:['gpt']}}]){
    assert.equal(busyHousehold(living,'gpt'),true);assert.equal(enterLeisure(f.world,'gpt','walk',{living,now:NOW}).ok,false);
  }
  assert.equal(JSON.stringify(f.world.avatars),before);
  const d=walkDestination(f.world,'gpt');assert.ok(d);f.world.move('gpt',d.point);
  assert.equal(enterLeisure(f.world,'gpt','sleep',{now:NOW}).error,'busy');
});
test('ambient wandering moves one eligible long-staying awake resident, including a former bed user',t=>{
  const f=fixture(t);f.world.useFurniture('gpt',f.world.home.furniture['adina-bed'].at);
  const rhythm=new RoomRhythm();rhythm.observe(f.world,{active:true,now:NOW});
  for(let now=NOW+1000;now<=NOW+30*M;now+=1000)rhythm.observe(f.world,{active:true,now});
  f.time(NOW+30*M);
  assert.equal(rhythm.ambientStep(f.world,{eligible:[],now:NOW+30*M}),null,'resting residents are not eligible');
  assert.equal(rhythm.ambientStep(f.world,{eligible:['gpt'],photoBusy:true,now:NOW+30*M}),null);
  const step=rhythm.ambientStep(f.world,{eligible:['gpt','gemini'],now:NOW+30*M});assert.equal(step.actor,'gpt');
  assert.equal(f.world.move(step.actor,step.point),true);assert.equal(f.world.avatars.gpt.posture,'stand');
  assert.equal(rhythm.ambientStep(f.world,{eligible:['gemini'],now:NOW+31*M}),null);
});
test('different goodnight phrasing is recognized as a sustained closed conversation',()=>{
  const texts=['다들 잘 자!','이번엔 정말 눈 감겠어요.','좋은 밤이다.','다들 아침에 보자.'];
  const messages=Array.from({length:24},(_,i)=>({from:IDS[i%4],ts:NOW-(24-i)*20000,text:texts[i%4]}));
  assert.equal(repeatedConversation(messages,NOW),true);
  assert.equal(repeatedConversation([...messages,{from:'user',ts:NOW,text:'조금 더 얘기하자'}],NOW),false);
});
