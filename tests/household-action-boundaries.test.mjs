import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {LIVING_CHAT_SCHEMA,CLAUDE_CHAT_SCHEMA,claudeStructuredReply} from '../lib/agents.mjs';
import {LEISURE,leisureRequest} from '../lib/household-flow.mjs';
import {CONSTRUCTION_ACTIONS} from '../lib/world-actions.mjs';
const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');

test('Eleven living structured output declares all leisure kinds without enabling construction',()=>{
  const schema=LIVING_CHAT_SCHEMA.properties.leisure;
  assert.equal(LIVING_CHAT_SCHEMA.additionalProperties,false);
  assert.equal(schema.type,'object');assert.equal(schema.additionalProperties,false);
  assert.deepEqual(schema.required,['kind']);
  assert.deepEqual(schema.properties.kind.enum,Object.keys(LEISURE));
  assert.equal(schema.properties.minutes.type,'integer');
  assert.equal(schema.properties.minutes.minimum,1);assert.equal(schema.properties.minutes.maximum,60);
  assert.deepEqual(schema,CLAUDE_CHAT_SCHEMA.properties.leisure);
  for(const key of CONSTRUCTION_ACTIONS)assert.equal(Object.hasOwn(LIVING_CHAT_SCHEMA.properties,key),false);
  for(const kind of schema.properties.kind.enum){
    const action={action:'pass',leisure:{kind,minutes:6}};
    const reply=JSON.parse(claudeStructuredReply({type:'result',is_error:false,subtype:'success',structured_output:action}));
    assert.deepEqual(reply,action);assert.ok(leisureRequest(reply.leisure));
  }
});

test('falsy leisure cannot reach continuation calls or capture before actual perform rejects it',async()=>{
  for(const value of [null,false])for(const key of ['open','world_look','world_shot']){
    const act={action:'pass',leisure:value,[key]:key==='open'?'story.md':{}};
    let asks=0,reads=0,shots=0,maps=0,worldActions=0;
    const notices=[];
    const a={id:'gpt',seen:0,reason:'new',fails:0};
    const context=vm.createContext({
      room:{running:true,sleeping:false},shuttingDown:false,PLAN_ACTIONS:CONSTRUCTION_ACTIONS,
      setStatus(){},hasBoost:()=>false,turnMeta:()=>({}),saveSoon(){},pushMembers(){},
      askRouted:async()=>{asks++;return {act,deep:null};},spark:{who:null},
      store:{lastId:1,readFile:()=>{reads++;throw Error('Unexpected read');},log:(_id,message)=>{throw Error(message);}},
      takeWorldShot:async()=>{shots++;throw Error('Unexpected capture');},
      world:{look:()=>{maps++;throw Error('Unexpected map');}},
      leisureRequest,post:message=>notices.push(message),
      performWorldAction:async()=>{worldActions++;},
    });
    vm.runInContext(server.match(/^async function perform\([^]*?^}/m)[0]+'\n'+server.match(/^async function runTurn\([^]*?^}/m)[0]+'\nglobalThis.runTurn=runTurn;',context);
    await context.runTurn(a);
    assert.equal(asks,1,`${key}/${value}`);
    assert.equal(reads+shots+maps+worldActions,0);
    assert.equal(a.fails,0);assert.equal(a.busy,false);
    assert.equal(notices.length,1);assert.equal(notices[0].kind,'info');
    assert.match(notices[0].text,/자유시간 요청/);
    assert.equal(Object.hasOwn(act,'leisure'),true,'the invalid original action is not replaced');
  }
});
