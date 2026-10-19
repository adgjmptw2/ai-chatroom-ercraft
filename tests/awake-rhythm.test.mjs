import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {HouseholdFlow,leisureRequest,enterLeisure} from '../lib/household-flow.mjs';
import ko from '../lib/prompts/ko.mjs';
const M=60000,NOW=1800000000000;

test('finishing a short break permits awake activities and silence, not another immediate nap',()=>{
 const f=new HouseholdFlow();assert.equal(f.start('gpt',{kind:'rest',minutes:20},NOW),true);
 assert.equal(f.start('gpt',{kind:'rest',minutes:30},NOW+M),false,'cannot repeatedly extend a break');
 f.expire(NOW+20*M);const saved=f.snapshot(),reload=new HouseholdFlow(saved);
 for(const kind of ['rest','sleep'])assert.equal(reload.canStart('gpt',{kind},NOW+21*M),false);
 for(const kind of ['write','read','draw','music','walk','tidy'])assert.equal(reload.canStart('gpt',{kind},NOW+21*M),true);
 assert.equal(reload.blocks('gpt',{now:NOW+21*M}),false,'no enforced busywork or compulsory speech');
 assert.equal(reload.canStart('gpt',{kind:'rest'},NOW+90*M),true);
 assert.deepEqual(reload.snapshot(),saved,'checking eligibility does not alter stored history');
});

test('a completed sleep gets a longer interval even after a different activity; host wake remains possible',()=>{
 const f=new HouseholdFlow();f.start('deepseek',{kind:'sleep',minutes:60},NOW);
 assert.equal(f.blocks('deepseek',{directHost:true,now:NOW+M}),false);
 f.interrupt('deepseek');assert.equal(f.start('deepseek',{kind:'read'},NOW+M),true);
 const restored=new HouseholdFlow(f.snapshot());
 assert.equal(restored.canStart('deepseek',{kind:'sleep'},NOW+180*M),false);
 assert.equal(restored.canStart('deepseek',{kind:'sleep'},NOW+240*M),true);
 assert.equal(restored.canStart('gemini',{kind:'sleep'},NOW+M),true,'no synchronized room-wide bedtime');
});

test('actual world-action handler rejects repeated rest before moving anyone or writing runtime data',async()=>{
 const flow=new HouseholdFlow();flow.start('gpt',{kind:'rest'},NOW-M);flow.interrupt('gpt');
 let moves=0,saves=0;const world={home:{id:'mulgyeol-maru'}};
 const c=vm.createContext({shuttingDown:false,room:{running:true,sleeping:false},world,leisureRequest,
  PLAN_ACTIONS:[],photocardQueue:null,AI_IDS:['gpt'],agents:{gpt:{imageBusy:false}},living:null,
  householdFlow:{canStart:(id,r)=>flow.canStart(id,r,NOW),start:()=>assert.fail('blocked rest started')},
  enterLeisure:()=>{moves++;return {ok:true};},saveSoon:()=>saves++,store:{log(){},lastId:1},post:()=>assert.fail('no public error spam')});
 const s=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 vm.runInContext(s.match(/^async function performWorldAction\([^]*?^}/m)[0]+'\nglobalThis.run=performWorldAction;',c);
 const before=flow.snapshot();assert.equal(await c.run({id:'gpt'},{leisure:{kind:'rest'}}),false);
 assert.equal(moves+saves,0);assert.deepEqual(flow.snapshot(),before);
});

test('Korean ordinary silence examples no longer prescribe a 20-minute rest',()=>{
 assert.match(ko.sharedHomeBrief,/pass/);
 assert.doesNotMatch(JSON.stringify(ko),/\\"kind\\": \\"rest\\", \\"minutes\\": 20/);
});
