import test from 'node:test';
import assert from 'node:assert/strict';
import {devChainState} from '../lib/dev.mjs';
const now=1000, base=[{id:1,from:'user',ts:now},{id:2,from:'dev',text:'연결했습니다.',ts:now}];
const ai=(id,replyTo,text='차를 마셔요.',from=id%2?'gpt':'gemini')=>({id,from,replyTo,text,ts:now});
test('developer greeting never caps unrelated household conversation',()=>{
 const messages=[...base,...Array.from({length:15},(_,i)=>ai(i+3,i>0?i+2:undefined))];
 assert.equal(devChainState(messages,now),null);
});
test('direct, transitive, mention and multi-bubble developer replies retain the cap',()=>{
 for(const replies of [Array.from({length:6},(_,i)=>ai(i+3,2)),Array.from({length:6},(_,i)=>ai(i+3,i+2)),
 Array.from({length:6},(_,i)=>ai(i+3,undefined,'@나쟈 확인해 주세요')),
 [ai(3,2,'답변','gpt'),ai(4,undefined,'계속','gpt'),{from:'system'},ai(5,undefined,'계속','gpt'),ai(6,2,'답변','gemini'),ai(7,undefined,'계속','gemini'),ai(8,undefined,'계속','gemini')]]) {
  assert.ok(devChainState([...base,...replies],now));
  assert.equal(devChainState([...base,...replies,{from:'user',ts:now}],now),null);
  assert.equal(devChainState([...base,...replies],now+600001),null);
  assert.equal(devChainState([...base,...replies],now,{replyCap:0}),null);
 }
});
test('mixed social messages do not inflate cap; older developer roots and round limit remain active',()=>{
 const five=Array.from({length:5},(_,i)=>ai(i+3,2));
 const social=Array.from({length:10},(_,i)=>ai(i+8,999));
 assert.equal(devChainState([...base,...five,...social],now),null);
 assert.ok(devChainState([...base,...five,...social,ai(20,2)],now));
 assert.ok(devChainState([...base,{id:21,from:'dev',ts:now},...Array.from({length:6},(_,i)=>ai(i+22,2))],now));
 assert.ok(devChainState(Array.from({length:8},(_,i)=>({id:i,from:'dev',ts:now})),now));
 assert.equal(devChainState([...base,ai(3,999),ai(4,undefined)],now),null);
});
