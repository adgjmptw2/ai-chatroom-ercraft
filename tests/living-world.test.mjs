import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTRUCTION_ACTIONS, constructionAllowed, availableWorldAction } from '../lib/world-actions.mjs';
import { LIVING_CHAT_SCHEMA } from '../lib/agents.mjs';
import { buildBrief, buildTurn } from '../lib/prompt.mjs';
import { getLang, setLang } from '../lib/i18n.mjs';
import { AI_IDS } from '../lib/members.mjs';

test('living action boundary excludes every building command without altering social actions', () => {
  for (const cfg of [undefined, {}, {constructionEnabled:false}, {constructionEnabled:'true'}]) assert.equal(constructionAllowed(cfg),false);
  const action={action:'say',messages:['같이 차 마실래?'],move:[2,3],useFurniture:[4,1,5],world_shot:{},image:{photocard:true},
    ...Object.fromEntries(CONSTRUCTION_ACTIONS.map(k=>[k,{anything:true}]))};
  const before=JSON.stringify(action),result=availableWorldAction(action,{});
  assert.equal(JSON.stringify(action),before);
  for(const k of CONSTRUCTION_ACTIONS){assert.equal(Object.hasOwn(result,k),false);assert.equal(Object.hasOwn(LIVING_CHAT_SCHEMA.properties,k),false);}
  for(const k of ['messages','move','useFurniture','world_shot','image']){assert.deepEqual(result[k],action[k]);assert.ok(Object.hasOwn(LIVING_CHAT_SCHEMA.properties,k));}
  assert.equal(LIVING_CHAT_SCHEMA.additionalProperties,false);
  assert.equal(availableWorldAction(null,{}),null);
});

test('every resident receives only living-world tools in all three languages', () => {
  const language=getLang();
  try {
    for(const lang of ['ko','en','ja']) {
      setLang(lang);
      for(const id of AI_IDS) {
        const cfg={constructionEnabled:false,agents:{},roomName:'Fixture',userName:'Owner',historyForPrompt:8};
        const brief=buildBrief(id,cfg);
        assert.doesNotMatch(brief,/plan_request|build_plan|plan_pause|plan_cancel|block_define|"build"/);
        for(const k of ['move','useFurniture','world_look','world_shot'])assert.ok(brief.includes('"'+k+'"'));
        const store={messages:[],byId:new Map(),readNote:()=>'',listFiles:()=>[],recent:()=>[],after:()=>[],lastMessage:()=>null};
        const turn=buildTurn(id,{store,cfg,agent:{seen:0},reason:'new',world:'HOME_LANDMARKS',plans:'FORBIDDEN_PLANNER_CONTEXT'});
        assert.ok(turn.includes('HOME_LANDMARKS'));assert.ok(!turn.includes('FORBIDDEN_PLANNER_CONTEXT'));
      }
    }
  } finally {setLang(language);}
});
