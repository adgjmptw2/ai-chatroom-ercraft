import test from 'node:test';
import assert from 'node:assert/strict';
import { PhotoMoments } from '../lib/photo-moments.mjs';
import { buildBrief } from '../lib/prompt.mjs';
import { parsePhotocardRequest, HOME_PHOTO_GAP_MS } from '../lib/photocards.mjs';
import { setLang } from '../lib/i18n.mjs';

const M=60_000, NOW=1800000000000;
const names={gpt:'아디나',gemini:'비앙카',claude:'일레븐',deepseek:'루치아'};
const members=Object.entries(names).map(([id,name])=>({id,name}));
const point=(x,z=10,posture='stand')=>({x,y:4,z,posture});
const fixture=()=>({home:{rooms:[],commonRoomZones:[{id:'courtyard',rectXZ:[5,5,30,30]}]},
  avatars:{gpt:point(10),gemini:point(11),claude:point(12),deepseek:point(13)},
  actor:'gpt',messages:[{from:'gpt',ts:NOW-60*M,text:'창밖의 바람 얘기'}],
  lastPhotoAt:NOW-40*M,available:true,nameOf:id=>names[id],now:NOW});
function settle(h,f){assert.equal(h.hint({...f,now:f.now-M}), '');return h.hint(f);}
function request(text){const json=text.match(/예: (\{"image":.*?\})\. 장면/);assert.ok(json,text);return JSON.parse(json[1]).image;}
const photo=(subjects, {from='deepseek',ts=NOW-40*M,path='images/success.png'}={})=>({
 from,ts,attach:{path,photocard:true,prompt:'a candid moment',...(subjects===undefined?{}:{photoSubjects:subjects})}});
function sample(f,n=1000){
 const result=[];
 for(let i=0;i<n;i++){
  const hint=settle(new PhotoMoments({random:()=>(i+.5)/n}),f);
  result.push(hint?request(hint).subjects:[]);
 }
 return result;
}
function freeze(value){
 if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
 return value;
}

test('a lone standing resident can suggest a photo without moving or seating anyone',()=>{
 const h=new PhotoMoments({random:()=>.1}), f=fixture();f.avatars={gpt:point(10)};
 const before=structuredClone(f.avatars), hint=settle(h,f), image=request(hint);
 assert.deepEqual(image.subjects,['아디나']);assert.deepEqual(f.avatars,before);
 assert.equal(parsePhotocardRequest(image,{members,requester:'gpt'}).subjects.length,1);
 assert.match(hint,/이번에는 넘기거나 다른 활동/);
});
test('nearby standing and working residents can form a pair; neither needs a sofa',()=>{
 const h=new PhotoMoments({random:()=>.6}),f=fixture();f.avatars={gpt:point(10),gemini:point(11,10,'work')};
 const image=request(settle(h,f));assert.deepEqual(image.subjects,['아디나','비앙카']);
 const parsed=parsePhotocardRequest(image,{members,requester:'gpt'});assert.equal(parsed.effort,'medium');
});
test('optional mix favors solo/pair, with group only for genuinely nearby people',()=>{
 const counts={solo:0,pair:0,group:0};
 for(const subjects of sample(fixture(),100))counts[subjects.length===1?'solo':subjects.length===2?'pair':'group']++;
 assert.deepEqual(counts,{solo:20,pair:50,group:30});
 const f=fixture();f.avatars.gemini.x=45;f.avatars.claude.y=8;f.avatars.deepseek.posture='lie';
 assert.deepEqual(request(settle(new PhotoMoments({random:()=>.99}),f)).subjects,['아디나']);
 assert.deepEqual(request(settle(new PhotoMoments({random:()=>.1}),f)).subjects,['아디나']);
});
test('walls represented by different room zones, sleep and unknown positions exclude companions',()=>{
 const f=fixture();f.home.rooms=[{id:'private',rectXZ:[11,9,15,12]}];
 assert.deepEqual(request(settle(new PhotoMoments({random:()=>.1}),f)).subjects,['아디나']);
 const g=fixture();g.blocked=id=>id!=='gpt';
 assert.deepEqual(request(settle(new PhotoMoments({random:()=>.1}),g)).subjects,['아디나']);
 for(const x of [NaN,48,-1]){const b=fixture();b.avatars.gpt.x=x;assert.equal(settle(new PhotoMoments(),b),'');}
});
test('host turns, continuation and unavailable generation never consume an offer',()=>{
 for(const patch of [{hostPending:true},{continuation:true},{available:false}]){
  const h=new PhotoMoments(),f=fixture();assert.equal(settle(h,{...f,...patch}),'');assert.ok(h.hint(f));
 }
});
test('arrival and a fresh position need a minute to settle; hints never mutate the world',()=>{
 const f=fixture(),h=new PhotoMoments();f.avatars.gpt={...point(10),moveId:NOW,path:[point(8),point(10)]};
 assert.equal(h.hint(f),'');assert.equal(h.hint({...f,now:NOW+2000}),'');
 assert.ok(h.hint({...f,now:NOW+62000}));
 const g=fixture(),h2=new PhotoMoments();h2.hint({...g,now:NOW-M});g.avatars.gpt.x=9;
 assert.equal(h2.hint(g),'');assert.ok(h2.hint({...g,now:NOW+M}));
});
test('successful photo gap is 35 minutes, or 25 when two distinct drawings followed it',()=>{
 const f=fixture();f.lastPhotoAt=NOW-30*M;
 assert.equal(settle(new PhotoMoments(),f),'');
 const drawing={from:'gemini',ts:NOW-2*M,attach:{path:'drawings/a.svg'}};
 f.messages.push(drawing,{...drawing,ts:NOW-M});assert.equal(settle(new PhotoMoments(),f),'');
 f.messages.push({...drawing,attach:{path:'drawings/b.svg'}});assert.ok(settle(new PhotoMoments(),f));
 f.lastPhotoAt=NOW-24*M;assert.equal(settle(new PhotoMoments(),f),'');
 assert.equal(HOME_PHOTO_GAP_MS,20*M,'hard queue guard remains unchanged');
});
test('ignored offers wait three minutes globally and twelve per actor, not a success interval',()=>{
 const f=fixture(),h=new PhotoMoments({random:()=>.1});assert.ok(settle(h,f));
 for(const actor of Object.keys(names))assert.equal(h.hint({...f,actor,now:NOW+M}),'');
 assert.equal(h.hint({...f,actor:'claude',now:NOW+3*M-1}),'');
 assert.ok(h.hint({...f,actor:'claude',now:NOW+3*M}));
 assert.equal(h.hint({...f,now:NOW+12*M-1}),'');
 assert.ok(h.hint({...f,now:NOW+12*M}));
 assert.equal(h.hint({...f,actor:'deepseek',now:NOW+15*M,lastPhotoAt:NOW+10*M}), '','newly completed photo resets room cadence');
});
test('empty/new rooms wait for actual conversation; captions and repeated old art cannot accelerate photos',()=>{
 for(const messages of [[],[{from:'gpt',ts:NOW-M,text:'사진 찍었어'}]]){
  const f={...fixture(),lastPhotoAt:0,messages};assert.equal(settle(new PhotoMoments(),f),'');
 }
 const f=fixture();f.lastPhotoAt=NOW-30*M;
 f.messages.push(...['a','b'].map(n=>({from:'gpt',ts:NOW-4*60*M,attach:{path:n+'.svg'}})));
 assert.equal(settle(new PhotoMoments(),f),'');
});
test('completed Eleven solos favor other nearby solos and pairs, regardless of uploader',()=>{
 const f=fixture(),baseline=sample(f);
 f.messages.push(...Array.from({length:10},(_,i)=>photo(['claude'],{from:'gemini',path:`images/photo-${i}.png`})));
 const changed=sample(f),elevenSolo=s=>s.length===1&&s[0]===names.claude;
 const otherPair=s=>s.length===2&&!s.includes(names.claude);
 const otherSolo=s=>s.length===1&&!s.includes(names.claude)&&!s.includes(names.gpt);
 assert.ok(changed.filter(elevenSolo).length<baseline.filter(elevenSolo).length/4);
 assert.ok(changed.filter(otherPair).length>baseline.filter(otherPair).length);
 assert.ok(changed.filter(otherSolo).length/changed.filter(s=>s.length===1).length
   >baseline.filter(otherSolo).length/baseline.filter(s=>s.length===1).length,
   'remaining solos favor other people while the overall solo share shrinks');
 assert.ok(changed.some(s=>s.length===2&&!s.includes(names.gpt)),'the photographer need not appear');
 assert.ok(elevenSolo(request(settle(new PhotoMoments({random:()=>0}),{...f,actor:'claude'})).subjects),
   'even the heavily downweighted repeated solo still has nonzero probability');
});

test('repeated pairs are penalized as a combination with canonical ID order and deduplication',()=>{
 const f=fixture(),base=sample(f);
 f.messages.push(...Array.from({length:6},(_,i)=>photo(['gemini','gpt'],{path:`images/pair-${i}.png`})));
 const changed=sample(f),same=s=>s.length===2&&s.includes(names.gpt)&&s.includes(names.gemini);
 assert.ok(changed.filter(same).length<base.filter(same).length/4);
 assert.ok(changed.some(same),'a repeated pair is still possible');
 const normalized={...f,messages:f.messages.map(m=>m.attach?{...m,attach:{...m.attach,photoSubjects:['gpt','gemini','gpt']}}:m)};
 assert.deepEqual(sample(normalized,100),sample(f,100));
 const repost={...fixture(),messages:[...fixture().messages,photo(['claude'])]};
 assert.deepEqual(sample({...repost,messages:[...repost.messages,...Array(20).fill(repost.messages.at(-1))]},100),sample(repost,100));
});

test('successful photographers yield softly to less represented actors',()=>{
 const f=fixture();f.messages.push(...Array.from({length:8},(_,i)=>photo(['gpt'],{from:'claude',path:`images/actor-${i}.png`})));
 const frequent=sample({...f,actor:'claude'}).filter(s=>s.length),other=sample({...f,actor:'gemini'}).filter(s=>s.length);
 assert.ok(frequent.length>0&&frequent.length<other.length/2);
 assert.equal(parsePhotocardRequest({photocard:true,prompt:'요청한 일레븐 사진',subjects:[names.claude]},
  {members,requester:'claude'}).subjects[0].id,'claude','suggestion weighting never vetoes a requested photo');
});

test('failed, requested, unknown and invalid-subject photos cannot supply subject history',()=>{
 const baseline=sample(fixture(),100),valid=photo(['claude']);
 const invalid=[undefined,null,[],['claude','stranger'],['일레븐'],['CLAUDE'],[' claude '],
  [{id:'claude'}],['claude',42],['claude',null],'claude',Array(2),Array(5).fill('claude')];
 for(const photoSubjects of invalid){
  const f=fixture();f.messages.push(photo(photoSubjects,{from:'claude',path:'images/claude-solo.png'}));
  assert.deepEqual(sample(f,100),baseline,`unknown subjects: ${JSON.stringify(photoSubjects)}`);
 }
 const ignored=[
  {from:'gpt',ts:NOW-M,text:'일레븐 사진 찍었어',image:{photocard:true,subjects:['claude']}},
  {...valid,from:'gpt',ts:NOW-M,attach:{photocard:true,prompt:'일레븐',photoSubjects:['claude']}},
  {...valid,from:'gpt',ts:NOW-M,kind:'error'},
  {...valid,from:'gpt',ts:NOW-M,status:'failed'},
  {...valid,from:'gpt',ts:NOW-M,attach:{...valid.attach,status:'pending'}},
  {...valid,from:'gpt',ts:NOW-M,ok:false},
  {...valid,from:'gpt',ts:NOW-M,attach:{...valid.attach,error:'failed'}},
  {...valid,from:'user'}, {...valid,from:'system'},
  ...[NaN,Infinity,-1,NOW+.5,NOW+M,'1800000000000'].map(ts=>({...valid,ts})),
 ];
 for(const m of ignored){
  const f=fixture();f.messages.push(m,null);
  assert.deepEqual(sample(f,100),baseline);
 }
});

test('successful attachments reset cadence even without subjects or a fresh lastPhotoAt',()=>{
 const f=fixture(),h=new PhotoMoments({random:()=>.1});
 f.messages.push(photo(undefined,{ts:NOW-20*M}));
 assert.equal(settle(h,f),'');
 assert.equal(h.hint({...f,now:NOW+15*M-1}),'');
 assert.ok(h.hint({...f,now:NOW+15*M}));
 const drawings={...f,messages:[...f.messages,...['a','b'].map(n=>({from:'gpt',ts:NOW-M,attach:{path:`${n}.svg`}}))]};
 assert.equal(settle(new PhotoMoments({random:()=>.1}),drawings),'');
 assert.ok(settle(new PhotoMoments({random:()=>.1}),{...drawings,now:NOW+5*M}));
});

test('an unavailable pair does not suppress a real solo moment or give the room fictitious companions',()=>{
 const f=fixture();f.avatars={gpt:point(10)};
 const samples=sample(f,100);assert.equal(samples.filter(s=>s.length).length,100);
 assert.ok(samples.every(s=>!s.length||s[0]===names.gpt));
 const h=new PhotoMoments({random:()=>.6});assert.ok(settle(h,f));
 assert.equal(h.hint(f),'','an emitted suggestion still respects its cooldown');
});

test('all subjects are visible in the actor zone and radius, including other-person candids',()=>{
 for(const avatars of [
  {gpt:point(10),gemini:point(16),claude:point(12,10,'sleep'),deepseek:point(13,10,'rest')},
  {gpt:point(10),gemini:point(15.01),claude:{...point(12),y:5},deepseek:point(NaN)},
  {gpt:point(10),gemini:{...point(15),y:4.5},claude:point(12,10,'lie')},
 ]){
  const f={...fixture(),avatars};
  for(const subjects of sample(f,100))assert.ok(subjects.every(name=>name===names.gpt));
 }
 const boundary={...fixture(),avatars:{gpt:point(10),gemini:point(15)}};
 assert.deepEqual(request(settle(new PhotoMoments({random:()=>.6}),boundary)).subjects,[names.gpt,names.gemini]);
 const otherRoom=fixture();otherRoom.home.rooms=[{id:'private',rectXZ:[11,9,15,12]}];
 for(const subjects of sample(otherRoom,100))assert.ok(subjects.every(name=>name===names.gpt));
 for(const avatars of [{}, {gemini:point(11)}, {gpt:point(1)}, {gpt:point(10,10,'lie')},
  {gpt:point(10,10,'sleep')},{gpt:point(10,10,'rest')}])assert.equal(settle(new PhotoMoments(),{...fixture(),avatars}),'');
});

test('blocked residents and arriving companions must settle again before being suggested',()=>{
 const f=fixture(),h=new PhotoMoments({random:()=>.1});
 assert.equal(settle(h,{...f,blocked:id=>id==='gpt'}),'');
 assert.equal(h.hint(f),'');assert.ok(h.hint({...f,now:NOW+M}));
 const g={...fixture(),avatars:{gpt:point(10),gemini:{...point(11),moveId:NOW,path:[point(9),point(11)]}}};
 const pair=new PhotoMoments({random:()=>.6});
 assert.equal(settle(pair,{...g,available:false}),'');assert.equal(pair.hint({...g,available:false,now:NOW+2000}),'');
 assert.equal(pair.hint({...g,available:false,now:NOW+61999}),'');
 assert.deepEqual(request(pair.hint({...g,now:NOW+62000})).subjects,[names.gpt,names.gemini]);
});

test('history reads are bounded to 500 messages and old successes age out',()=>{
 const f=fixture(),recent=Array.from({length:500},()=>({from:'gpt',ts:NOW-60*M,text:'chat'}));
 const unreadable=new Proxy({}, {get(){assert.fail('read beyond bounded history');}});
 assert.deepEqual(sample({...f,messages:[...Array(20).fill(unreadable),...recent]},100),sample({...f,messages:recent},100));
 const newRoom={...f,lastPhotoAt:0,messages:[{from:'gpt',ts:NOW-60*M},...recent.map(m=>({...m,ts:NOW-M}))]};
 assert.equal(settle(new PhotoMoments(),newRoom),'');
 const old={...f,messages:[...f.messages,photo(['claude'],{from:'gpt',ts:NOW-4*60*M})]};
 assert.deepEqual(sample(old,100),sample(f,100));
 const edge={...f,messages:[photo(['claude']),...recent.slice(1)]};
 assert.notDeepEqual(sample(edge,100),sample(f,100),'the oldest entry in the window still counts');
});

test('invalid clocks cannot emit offers or poison cooldowns; clock rollback requires settling',()=>{
 const f=fixture(),h=new PhotoMoments({random:()=>.1});
 for(const now of [NaN,Infinity,-1,NOW+.5,'1800000000000'])assert.equal(h.hint({...f,now}),'');
 for(const lastPhotoAt of [NaN,Infinity,-1,NOW+M,'1800000000000'])assert.equal(h.hint({...f,lastPhotoAt}),'');
 assert.ok(settle(h,f));assert.equal(h.hint({...f,now:NOW-2*M}),'');
 assert.ok(h.hint({...f,now:NOW-M}));
 assert.equal(h.hint({...f,actor:'unknown',now:NOW+20*M}),'');
});

test('offer callback reports internal subjects once, only for emitted hints, without changing inputs',()=>{
 for(const [roll,kind] of [[.1,'solo'],[.6,'pair'],[.95,'group']]){
  const f=fixture(),before=structuredClone({home:f.home,avatars:f.avatars,messages:f.messages}),events=[];
  freeze(f.home);freeze(f.avatars);freeze(f.messages);
  const h=new PhotoMoments({random:()=>roll}),onOffer=e=>events.push(e);
  const image=request(settle(h,{...f,onOffer}));
  assert.equal(events.length,1);assert.equal(events[0].kind,kind);assert.equal(events[0].at,NOW);
  assert.deepEqual(events[0].subjects.map(id=>names[id]),image.subjects);
  assert.equal(h.hint({...f,onOffer,now:NOW+M}),'');assert.equal(events.length,1);
  assert.deepEqual({home:f.home,avatars:f.avatars,messages:f.messages},before);
 }
 for(const patch of [{available:false},{hostPending:true},{continuation:true},{blocked:()=>true},
  {lastPhotoAt:NOW-M}]){
  const events=[];
  assert.equal(settle(new PhotoMoments({random:()=>.6}),{...fixture(),...patch,onOffer:e=>events.push(e)}),'');
  assert.deepEqual(events,[],'rejected offers do not invoke diagnostics');
 }
 const f=fixture();f.messages.push(photo(['gemini','claude','gemini']));freeze(f.messages);
 assert.ok(settle(new PhotoMoments({random:()=>.1}),{...f,onOffer:e=>{e.subjects.length=0;throw new Error('log unavailable');}}));
});

test('all four briefs including compact Eleven describe their shared photo capability truthfully',()=>{
 setLang('ko');
 for(const id of Object.keys(names))for(const chatEfficiency of [false,true]){
  const cfg={roomName:'집',userName:'방장',constructionEnabled:false,imageGen:true,agents:{[id]:{chatEfficiency}}};
  const brief=buildBrief(id,cfg,{homePhotos:true});
  assert.doesNotMatch(brief,/너한테는 이미지 생성 도구가 없어/);
  if(['claude','deepseek'].includes(id)){
   assert.match(brief,/생활 사진은 네가 직접 공용 image/);
   assert.match(brief,/공용 생활 사진 가능.*일반 이미지 생성 불가/);
   assert.match(buildBrief(id,cfg,{homePhotos:false}),/이미지 생성=불가/);
  }
 }
});
