// Actual ask() bytes + real prompt/photo/household modules in a VM. No I/O or AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PhotoMoments } from '../lib/photo-moments.mjs';
import { HouseholdFlow, busyHousehold } from '../lib/household-flow.mjs';
import { CozyChatHints } from '../lib/cozy-chat.mjs';
import { AI_IDS, MEMBERS } from '../lib/members.mjs';
import { buildBrief, parseAction } from '../lib/prompt.mjs';
import { constructionAllowed, availableWorldAction } from '../lib/world-actions.mjs';
import { HOME_PHOTO_GAP_MS, lastHomePhotoAt } from '../lib/photocards.mjs';
import { setLang } from '../lib/i18n.mjs';
import ko from '../lib/prompts/ko.mjs';

test('actual ask offers a solo photo despite a resting neighbor, suppresses competing hints and adds no calls',async()=>{
 setLang('ko');const M=60000,NOW=1800000000000;let clock=NOW;
 const chats=[],seenOptions=[];let omitted=false;const flow=new HouseholdFlow(), photos=new PhotoMoments({random:()=>.6});
 flow.start('gemini',{kind:'rest',minutes:30},NOW);
 const agents=Object.fromEntries(AI_IDS.map(id=>[id,{id,imageBusy:false,calls:0,callTimes:[],seen:0}]));
 const avatars={gpt:{x:10,y:4,z:10,posture:'stand'},gemini:{x:11,y:4,z:10,posture:'stand'}};
 const context=vm.createContext({Date:class extends Date{static now(){return clock;}},shuttingDown:false,
   AI_IDS,agents,koPrompts:ko,enPrompts:ko,jaPrompts:ko,pick:()=>ko,parseAction,constructionAllowed,availableWorldAction,
   buildBrief:(id,cfg,opts)=>{seenOptions.push(opts);return buildBrief(id,cfg,opts);},
   photocardQueue:null,photoMoments:{hint:args=>photos.hint({...args,now:clock})},cozyChatHints:new CozyChatHints(),
   HOME_PHOTO_GAP_MS,lastHomePhotoAt,busyHousehold,
   householdFlow:{phase:id=>flow.phase(id,clock),context:()=>'',offer:()=> 'OPTIONAL_LEISURE'},
   roomRhythm:{hint:()=> 'OPTIONAL_WALK',allowSeatOffer:()=>true},
   living:null,room:{calls:0},topics:{context:()=>''},world:{
     home:{id:'mulgyeol-maru',rooms:[],commonRoomZones:[{id:'yard',rectXZ:[5,5,20,20]}]},
     avatarView:()=>avatars,summary:()=> 'actual home'},
   cfg:{imageGen:true,constructionEnabled:false,historyForPrompt:8,agents:{claude:{chatEfficiency:true}},roomName:'Fixture',userName:'Host'},
   avail:{gpt:true},devBridge:{online:false},plans:{},
   store:{messages:[{from:'gpt',ts:NOW-40*M,text:'창밖 이야기'}],recent:()=>[],after:()=>[],log(){}},
   name:id=>MEMBERS[id].name,boostMode:()=> 'off',hasBoost:()=>false,defaultLabel:()=> 'private',
   buildTurn:(id,data)=>{data.memoryState.omitted=omitted;return data.cozy;},pushRoom(){},pushUsageSoon(){},
   adapters:{canSee:()=>false,maxPromptChars:()=>100000,chat:async(id,brief,turn)=>{
     chats.push({id,brief,turn});return {ok:true,ms:0,text:'{"action":"pass","note_replace":"only the visible note","note_add":"a new memory"}'};
   }},
 });
 const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 vm.runInContext(source.match(/^async function ask\([^]*?^}/m)[0]+'\nglobalThis.askForTest=ask;',context);
 const full = await context.askForTest(agents.gpt,'new');assert.equal(full.note_replace,'only the visible note');clock+=M;
 await context.askForTest(agents.gpt,'new');
 assert.match(chats[1].turn,/"subjects":\["아디나"\]/,'resting Bianca must not be suggested');
 assert.doesNotMatch(chats[1].turn,/OPTIONAL_LEISURE|OPTIONAL_WALK/);
 assert.equal(chats.length,2);assert.equal(context.room.calls,2);
 await context.askForTest(agents.claude,'new');
 assert.equal(chats.length,3);assert.equal(seenOptions[2].homePhotos,true);
 assert.match(chats[2].brief,/생활 사진은 네가 직접 공용 image/);
 assert.doesNotMatch(chats[2].turn,/"subjects"/,'room hint gap applies to all members');
 clock+=40*M;agents.gpt.imageBusy=true;
 await context.askForTest(agents.deepseek,'new');
 assert.doesNotMatch(chats[3].turn,/"subjects"/,'general image job also suppresses a new photo offer');
 assert.equal(chats.length,4);assert.equal(context.room.calls,4);
 assert.equal(avatars.gpt.posture,'stand');assert.equal(avatars.gemini.x,11);
 omitted=true;
 const partial=await context.askForTest(agents.gpt,'new');
 assert.equal(Object.hasOwn(partial,'note_replace'),false,'actual ask protects omitted memories from replacement');
 assert.equal(partial.note_add,'a new memory','safe additions remain available');
 assert.equal(chats.length,5,'memory protection never asks a second model');
 // The same real ask() can offer an approach and a later shared photo without
 // another provider request, an automatic move, or a fake group attachment.
 agents.gpt.imageBusy=false;
 context.world.home.rooms=[{id:'yard',name:'중정',kind:'courtyard',rectXZ:[5,5,20,20]}];
 context.world.avatars=avatars;
 context.world.occupiedAt=()=>false;
 context.world.navigationPath=(self,goal)=>{
   const end={x:16,y:4,z:10};return goal(end)?[self,end]:null;
 };
 avatars.gpt.x=7;avatars.gemini.x=18;
 clock+=20*M;await context.askForTest(agents.gpt,'new');
 clock+=M;await context.askForTest(agents.gpt,'new');
 assert.match(chats[6].turn,/"move":\[16,10\]/);assert.doesNotMatch(chats[6].turn,/"image"/);
 assert.equal(avatars.gpt.x,7,'an offer is not a server-side teleport');
 avatars.gpt.x=16;clock+=M;await context.askForTest(agents.gpt,'new');
 clock+=M;await context.askForTest(agents.gpt,'new');
 assert.match(chats[8].turn,/"subjects":\["아디나","비앙카"\]/);
 assert.equal(chats.length,9);assert.equal(context.room.calls,9,'only the nine requested ordinary turns call a provider');
});
