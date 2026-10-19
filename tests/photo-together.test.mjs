import test from 'node:test';
import assert from 'node:assert/strict';
import {PhotoMoments,photoMeetingPoint} from '../lib/photo-moments.mjs';
import {World} from '../lib/world.mjs';
import {buildHouse} from '../lib/house.mjs';
import ko from '../lib/prompts/ko.mjs';
const M=60_000,NOW=1800000000000;
const names={gpt:'아디나',gemini:'비앙카',claude:'일레븐',deepseek:'루치아'};
const p=(x,z=10)=>({x,y:4,z,posture:'stand'});
function fixture(){
 const avatars={gpt:p(10),gemini:p(20),claude:p(21)};
 const home={rooms:[{id:'courtyard',name:'중정',kind:'courtyard',rectXZ:[5,5,30,30]}]};
 let searches=0;
 const world={home,avatars,occupiedAt:(id,p)=>Object.entries(avatars).some(([other,a])=>other!==id&&a.x===p.x&&a.z===p.z),
 navigationPath:(self,goal)=>{searches++;const end=p(18);return goal(end)?[self,end]:null;}};
 const f={home,avatars,world,actor:'gpt',messages:[{from:'gpt',ts:NOW-50*M,text:'바람 이야기'}],lastPhotoAt:NOW-40*M,
  available:true,nameOf:id=>names[id],now:NOW};
 return {f,get searches(){return searches;}};
}
const settle=(h,f)=>(h.hint({...f,now:NOW-M}),h.hint(f));
const subjects=text=>JSON.parse(text.match(/예: (\{"image":.*?\})\. 장면/)[1]).image.subjects;

test('separated awake residents get an optional real route, not a fabricated group photograph',()=>{
 const x=fixture(),h=new PhotoMoments({random:()=>.5}),events=[],before=JSON.stringify(x.f.avatars);
 const hint=settle(h,{...x.f,onOffer:e=>events.push(e)});
 assert.match(hint,/비앙카/);assert.match(hint,/일레븐/);assert.match(hint,/"move":\[18,10\]/);
 assert.doesNotMatch(hint,/"image"|"photocard"/);assert.match(hint,/초대는 참석·동의가 아니며/);
 assert.equal(JSON.stringify(x.f.avatars),before);assert.equal(x.searches,1);assert.equal(events[0].kind,'meet');
});

test('arrival after an invitation offers a real pair/group before the ordinary actor cooldown',()=>{
 const {f}=fixture(),h=new PhotoMoments({random:()=>.05});assert.match(settle(h,f),/이번 턴에는 촬영하지/);
 f.avatars.gpt=p(18);
 assert.equal(h.hint({...f,now:NOW+M}),'','changed position must settle');
 const hint=h.hint({...f,now:NOW+2*M});assert.ok(subjects(hint).length>=2,'meeting followup does not suggest another solo');
 assert.equal(h.hint({...f,now:NOW+4*M}),'','followup is consumed once');
});

test('ignored invitation cannot invent nearby people; invitations have a room-wide 20 minute gap',()=>{
 const x=fixture(),h=new PhotoMoments({random:()=>.1});assert.match(settle(h,x.f),/같이 한 장/);
 assert.equal(h.hint({...x.f,now:NOW+2*M}),'');
 const later=h.hint({...x.f,now:NOW+12*M});assert.deepEqual(subjects(later),['아디나']);
 assert.equal(x.searches,1);
});

test('sleep, rest, busy meal participants, moving people and missing positions never become invited subjects',()=>{
 for(const patch of [f=>f.blocked=id=>id!=='gpt',f=>{f.avatars.gemini.posture='lie';f.avatars.claude.posture='sleep';},
   f=>{f.avatars.gemini.x=NaN;delete f.avatars.claude;}]){
  const x=fixture();patch(x.f);const hint=settle(new PhotoMoments({random:()=>.1}),x.f);
  assert.deepEqual(subjects(hint),['아디나']);assert.equal(x.searches,0);
 }
 const x=fixture();for(const id of ['gemini','claude'])x.f.avatars[id]={...p(20),moveId:NOW,path:[p(1),p(45)]};
 assert.deepEqual(subjects(settle(new PhotoMoments({random:()=>.1}),x.f)),['아디나']);assert.equal(x.searches,0);
});

test('busy generation, host requests, continuations and recent successes do not search routes',()=>{
 for(const patch of [{available:false},{hostPending:true},{continuation:true},{lastPhotoAt:NOW-2*M}]){
  const x=fixture();assert.equal(settle(new PhotoMoments({random:()=>.1}),{...x.f,...patch}),'');assert.equal(x.searches,0);
 }
});

test('another participant resting after the invitation cannot be included in a followup photo',()=>{
 const {f}=fixture(),h=new PhotoMoments({random:()=>.1});settle(h,f);f.avatars.gpt=p(18);f.blocked=id=>id!=='gpt';
 assert.equal(h.hint({...f,now:NOW+M}),'');assert.equal(h.hint({...f,now:NOW+2*M}),'');
});

test('successful solo streak shifts compositions toward shared shots, unknown/failed/duplicate photos do not invent a streak',()=>{
 const {f}=fixture();f.avatars.gpt=p(19);f.avatars.deepseek=p(22);delete f.world;
 const photo=(i,ids,patch={})=>({from:'deepseek',ts:NOW-40*M-i,attach:{path:`images/${i}.png`,photocard:true,photoSubjects:ids},...patch});
 const samples=messages=>Array.from({length:1000},(_,i)=>subjects(settle(new PhotoMoments({random:()=>(i+.5)/1000}),{...f,messages}))).filter(s=>s.length===1).length;
 const base=samples(f.messages),known=[photo(0,['claude']),photo(1,['gemini'])];
 // Use chronological input, matching the Store contract.
 assert.ok(samples([...f.messages,...known.toReversed()])<base/2);
 for(const extra of [[photo(1,undefined),photo(0,['claude'])],[photo(0,['claude']),photo(0,['claude'])],
  [photo(1,['claude'],{kind:'error'}),photo(0,['gemini'])]])assert.ok(samples([...f.messages,...extra])>=base/2);
});

test('real house navigation joins a public companion and never writes or teleports anybody',()=>{
 const data=buildHouse(),world=Object.assign(Object.create(World.prototype),{
  home:data.home,avatars:{gpt:p(14,12),gemini:p(24,21),claude:p(25,21)},blocks:new Map(Object.entries(data.blocks))});
 const before=JSON.stringify(world.avatars);
 const target=photoMeetingPoint(world,'gpt',['gemini','claude']);assert.ok(target);
 assert.equal(target.place,'중정');assert.deepEqual(world.avatars,JSON.parse(before));
 assert.ok(Math.hypot(target.point[0]-24,target.point[1]-21)<=3);
 const unavailable={...world,navigationPath:()=>null,occupiedAt:()=>false};
 assert.equal(photoMeetingPoint(unavailable,'gpt',['gemini']),null);
});

test('private-room residents are invited to a common place; no private-room photo or arrival is fabricated',()=>{
 const data=buildHouse(),world=Object.assign(Object.create(World.prototype),{
  home:data.home,avatars:{gpt:p(14,12),gemini:p(21,12),claude:p(28,12)},blocks:new Map(Object.entries(data.blocks))});
 const target=photoMeetingPoint(world,'gpt',['gemini','claude']);assert.ok(target);assert.equal(target.place,'중정');
 assert.deepEqual(target.peers,['gemini','claude']);
 assert.ok(target.point[0]>=18&&target.point[0]<29&&target.point[1]>=20&&target.point[1]<26);
});

test('a real seated resident can get up and approach without the planner changing posture',()=>{
 const data=buildHouse(),world=Object.assign(Object.create(World.prototype),{
  home:data.home,avatars:{gpt:p(14,12),gemini:p(24,21)},blocks:new Map(Object.entries(data.blocks))});
 const at=data.home.furniture['adina-chair'].at,pose=world.furniturePose(at);
 const {shape,block,...position}=pose;assert.equal(position.posture,'sit');
 world.avatars.gpt={...position,furniture:{at,shape,block,returnTo:p(14,12)}};
 const before=JSON.stringify(world.avatars),target=photoMeetingPoint(world,'gpt',['gemini']);assert.ok(target);
 assert.equal(JSON.stringify(world.avatars),before);
});

test('shared brief encourages multi-person subjects without mandating attendance or same-turn photos',()=>{
 assert.match(ko.photocardBrief,/단체사진/);assert.match(ko.photocardBrief,/실제 함께 찍을 사람 이름을 모두/);
 assert.match(ko.photocardBrief,/제안·참여·거절 모두 자유/);assert.match(ko.photocardBrief,/이동·착석과 촬영은 별도 턴/);
});
