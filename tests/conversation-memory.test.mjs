import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationMemory } from '../lib/conversation-memory.mjs';
import { buildTurn } from '../lib/prompt.mjs';
import { setLang } from '../lib/i18n.mjs';
const now = new Date(2026,9,3,20,0).getTime(), M=60000;
const promise = '약속: 내일 아침 햄버거와 토마토소스 준비. 비앙카가 심사관 역할.';
const messages = Array.from({length:20},(_,i)=>({id:i+1,from:i%2?'claude':'gemini',ts:now-(60-i*3)*M,
 text:i%2?'토마토소스 햄버거 완성도 기대돼!':'햄버거에 토마토소스라니, 내일 맛보겠구나.'}));
test('an over-discussed promise is held outside working memory without changing notes/history',()=>{
 const copy=structuredClone(messages), note=promise+'\n취향: 시원한 바닷바람이 좋다.';
 const out=conversationMemory(note,{messages,now});
 assert.doesNotMatch(out.note,/토마토소스/);assert.match(out.note,/바닷바람/);assert.match(out.note,/원본 개인 메모/);
 assert.match(out.hint,/새로 말한 내용/);assert.deepEqual(messages,copy);assert.ok(note.includes(promise));
});
test('a prohibition attached to an echoed promise remains visible and replacements are disallowed in the prompt',()=>{
 const note=promise+' 늦잠 금지 당부함.';
 const out=conversationMemory(note,{messages,now});
 assert.match(out.note,/늦잠 금지/);assert.match(out.note,/note_replace는 쓰지 않고/);
});
test('fresh host requests, explicit questions, due-today and constraints retain the complete promise',()=>{
 for(const fresh of [[{from:'user',text:'내일 약속 알려줘'}],[{from:'dev',text:'확인'}],
   [{from:'gpt',text:'햄버거 토마토소스 약속 기억나?'}]]){
  assert.equal(conversationMemory(promise,{messages,fresh,now}).note,promise);
 }
 for(const line of ['약속: 10/3 햄버거와 토마토소스 준비.', '약속: 2026-10-03 햄버거와 토마토소스 준비.',
  '약속: 햄버거와 토마토소스는 취소.','약속: 햄버거 토마토소스 알레르기 유의.']){
  assert.equal(conversationMemory(line,{messages,now}).note,line);
 }
});
test('one word, old evidence, system text, a recent host boundary or a new promise never suppress memory',()=>{
 for(const chat of [messages.slice(0,5),messages.map(m=>({...m,text:'햄버거 이야기'})),
  messages.map(m=>({...m,from:'system'})),messages.map(m=>({...m,ts:now-5*60*M})),
  [...messages,{from:'user',text:'그 이야기를 더 들려줘',ts:now}]]){
  assert.equal(conversationMemory(promise,{messages:chat,now}).note,promise);
 }
 const line='약속: 내일 우주선 조종과 망원경 관찰.';
 assert.equal(conversationMemory(line,{messages,now}).note,line);
});
test('actual prompt uses the bounded memory view but opened-file continuations retain full context',t=>{
 t.mock.method(Date,'now',()=>now);setLang('ko');
 const store={messages,recent:n=>messages.slice(-n),after:()=>[],getMessage:id=>messages.find(m=>m.id===id),
  lastMessage:()=>messages.at(-1),readNote:()=>promise,listFiles:()=>[]};
 const ctx={store,cfg:{roomName:'집',userName:'방장',historyForPrompt:8,constructionEnabled:false,agents:{}},
  agent:{seen:20},reason:'spark'};
 const memoryState={}; const turn=buildTurn('claude',{...ctx,memoryState});assert.match(turn,/원본 개인 메모/);assert.doesNotMatch(turn,/약속: 내일 아침 햄버거/);
 assert.equal(memoryState.omitted,true);
 const continued=buildTurn('claude',{...ctx,openFile:{rel:'a.txt',text:'작업 중'}});
 assert.match(continued,/약속: 내일 아침 햄버거/);
});
