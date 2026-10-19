import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_CHAT_SCHEMA, claudeStructuredReply } from '../lib/agents.mjs';
const envelope = structured_output => ({type:'result',is_error:false,subtype:'success',structured_output});

test('structured chat keeps speech and every optional action unchanged', () => {
 const action={action:'say',messages:['그건 내 취향이 아닌데!'],reply_to:15,
   useFurniture:[1,2,3],build_plan:{id:'#1',stage:'next',continue:true},
   files:[{op:'write',path:'a.md',content:'내용'}],note_add:'내 취향',react:{id:14,emoji:'😂'}};
 assert.deepEqual(JSON.parse(claudeStructuredReply(envelope(action))),action);
 assert.deepEqual(JSON.parse(claudeStructuredReply(envelope({action:'pass',plan_pause:{id:'#1'}}))),{action:'pass',plan_pause:{id:'#1'}});
 assert.equal(CLAUDE_CHAT_SCHEMA.additionalProperties,true);
});

test('prose, result-only fallbacks, malformed speech, and provider errors never become actions', () => {
 for(const value of [null, {type:'result',is_error:false,subtype:'success',result:'{"action":"say","messages":["invented fallback"]}'},
   {...envelope({action:'say',messages:['partial']}),is_error:true},
   {...envelope({action:'say',messages:['partial']}),subtype:'error_max_turns'},
   envelope([]),envelope({action:'say'}),envelope({action:'say',messages:[' ']}),
   envelope({action:'say',messages:'text'}),envelope({action:'say',messages:[1]}),
   envelope({action:'unknown'}),envelope({action:'say',messages:['x'],reply_to:'15'})]) assert.equal(claudeStructuredReply(value),'');
});

test('a legacy stringified file array is decoded exactly once without changing source text', () => {
 const content='<svg xmlns="http://www.w3.org/2000/svg"><text>\\n \\" 한글</text></svg>';
 const files=[{op:'write',path:'images/parasol_bianca.svg',content}];
 const action={action:'pass',files:JSON.stringify(files),show:files[0].path};
 const decoded=JSON.parse(claudeStructuredReply(envelope(action)));
 assert.deepEqual(decoded,{...action,files});
 assert.equal(action.files,JSON.stringify(files),'the original envelope remains unchanged');
 for(const files of ['not JSON','{}',JSON.stringify(JSON.stringify([])),null,{},[null],
   [{op:'write',path:'a.svg'}],[{op:'append',path:'a.svg',content:{}}],
   [{op:'edit',path:'a.svg',find:'',replace:'x'}],[{op:'edit',path:'a.svg',find:'x'}],
   [{op:'delete'}],[{op:'unknown',path:'a.svg'}]]) {
   assert.equal(claudeStructuredReply(envelope({action:'pass',files})), '');
 }
});

test('camera vectors and glowing signs remain typed optional room actions', () => {
 const action={action:'pass',world_shot:{from:[1.5,8,3],look_at:[2,1,3],quat:[0,0.5,0,0.5]},
   build:[{op:'sign',at:[2,1,3],text:'밤하늘',glow:true}]};
 assert.deepEqual(JSON.parse(claudeStructuredReply(envelope(action))),action);
 for(const field of ['from','look_at','quat']) {
   assert.equal(CLAUDE_CHAT_SCHEMA.properties.world_shot.properties[field].type,'array');
   assert.equal(CLAUDE_CHAT_SCHEMA.properties.world_shot.properties[field].items.type,'number');
 }
 assert.equal(CLAUDE_CHAT_SCHEMA.properties.build.items.properties.glow.type,'boolean');
});
