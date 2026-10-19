import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LivingRoom } from '../lib/living.mjs';
import { applyLivingAction, publicLiving } from '../lib/living-integration.mjs';
import { World } from '../lib/world.mjs';
import { buildHouse } from '../lib/house.mjs';
import { AI_IDS } from '../lib/members.mjs';
import { LIVING_CHAT_SCHEMA } from '../lib/agents.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ercraft-props-'));
  fs.mkdirSync(path.join(root,'data'));
  const house = buildHouse();
  fs.writeFileSync(path.join(root,'data','world.json'),JSON.stringify(house));
  const world = new World(root, AI_IDS), room = new LivingRoom(root,{members:AI_IDS, now:()=>1000});
  room.resume(1000);
  t.after(()=>{
    clearTimeout(world.saveTimer);
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ercraft-props-'));
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,room,world,act:(id,cmd)=>applyLivingAction(room,world,id,cmd,1000)};
}
const ok = result => assert.equal(result.ok,true,JSON.stringify(result));
const rev = room => room.view().props?.revision ?? 0;
const spread = (room,spot='sofa-1',style='mint') => ({op:'blanket_spread',spot,style,revision:rev(room)});

test('legacy state remains unchanged on read; props persist without replacing meals/game or world geometry', t=>{
  const f=fixture(t), file=path.join(f.root,'data','living.json'), before=fs.readFileSync(file,'utf8');
  assert.equal(Object.hasOwn(f.room.view(),'props'),false);
  const reload=new LivingRoom(f.root,{members:AI_IDS,now:()=>1000});
  assert.equal(fs.readFileSync(file,'utf8'),before);
  const blocks=JSON.stringify([...f.world.blocks]);
  ok(f.act('gpt',spread(reload)));
  assert.equal(f.world.avatars.gpt.posture,'sit');
  assert.equal(JSON.stringify([...f.world.blocks]),blocks);
  assert.deepEqual(new LivingRoom(f.root,{members:AI_IDS}).view(),f.room.view());
  assert.equal(f.room.view().meal,null); assert.equal(f.room.view().game,null);
});

test('blankets require a free real seat, never move another member, and reject stale/fold ownership',t=>{
  const f=fixture(t);
  ok(f.act('gpt',spread(f.room)));
  const old=spread(f.room,'sofa-2','pink');
  ok(f.act('claude',old));
  const state=f.room.view(), avatars=f.world.avatarView();
  assert.equal(f.act('gemini',old).error,'stale_revision');
  assert.equal(f.act('gemini',{op:'blanket_fold',spot:'sofa-1',revision:rev(f.room)}).error,'not_blanket_owner');
  assert.equal(f.act('gemini',{op:'relax',spot:'sofa-1'}).ok,false);
  assert.deepEqual(f.world.avatarView(),avatars); assert.deepEqual(f.room.view(),state);
  ok(f.act('gpt',{op:'blanket_fold',spot:'sofa-1',revision:rev(f.room)}));
  assert.equal(f.room.view().props.blankets.length,1);
});

test('beds recline while sofa stays seated; fake/missing anchors fail before state mutation',t=>{
  const f=fixture(t);
  ok(f.act('gpt',spread(f.room,'adina-bed')));
  assert.equal(f.world.avatars.gpt.posture,'lie');
  ok(f.act('claude',{op:'relax',spot:'sofa-3'}));
  assert.equal(f.world.avatars.claude.posture,'sit');
  const before=f.room.view();
  assert.equal(f.act('gemini',{op:'relax',spot:'floor'}).ok,false);
  f.world.blocks.delete(f.world.home.furniture['bianca-bed'].at.join(','));
  assert.equal(f.act('gemini',spread(f.room,'bianca-bed')).ok,false);
  assert.deepEqual(f.room.view(),before);
});

test('table settings cannot discard served food; props revisions are independent of meals',t=>{
  const f=fixture(t);
  ok(f.act('gpt',{op:'table_set',revision:0}));
  ok(f.act('claude',{op:'cook',recipe:'dumplings'}));
  assert.equal(rev(f.room),1);
  f.room.advance(f.room.view().meal.readyAt);
  let meal=f.room.view().meal;
  ok(f.act('claude',{op:'serve',mealId:meal.id,revision:meal.revision}));
  const before=f.room.view();
  assert.equal(f.act('gpt',{op:'table_clear',revision:1}).error,'food_on_table');
  assert.deepEqual(f.room.view(),before);
  meal=f.room.view().meal;
  ok(f.act('claude',{op:'meal_clear',mealId:meal.id,revision:meal.revision}));
  ok(f.act('gpt',{op:'table_clear',revision:1}));
  assert.equal(f.room.view().props.tableSet,false);
});

test('failed props persistence restores actual avatar and route; public props never expose routing IDs',t=>{
  const f=fixture(t), before=f.world.avatarView(), current=f.room.view();
  const file=path.join(f.root,'data','living.json'), held=file+'.held';
  fs.renameSync(file,held); fs.mkdirSync(file);
  const result=f.act('gpt',spread(f.room));
  assert.equal(result.error,'living_persist_failed');
  assert.deepEqual(f.world.avatarView(),before); assert.deepEqual(f.room.view(),current);
  fs.rmdirSync(file); fs.renameSync(held,file);
  ok(f.act('gpt',spread(f.room)));
  const view=publicLiving(f.room.view());
  assert.equal(view.props.blankets[0].owner,'adina');
  assert.doesNotMatch(JSON.stringify(view),/gpt|claude|gemini|deepseek/);
});

test('four blanket cap, invalid styles, paused actions and corrupt persistence are bounded',t=>{
  const f=fixture(t);
  for(let i=0;i<4;i++) ok(f.room.act(AI_IDS[i],spread(f.room,`sofa-${i+1}`),1000));
  assert.equal(f.room.act('gpt',spread(f.room,'adina-bed'),1000).error,'blanket_limit');
  assert.equal(f.room.act('gpt',spread(f.room,'adina-bed','anything'),1000).error,'invalid_style');
  f.room.pause(1000);
  assert.equal(f.room.act('gpt',{op:'relax',spot:'adina-bed'},1000).error,'living_paused');
  const state=f.room.view(); state.props.blankets[0].owner='stranger';
  fs.writeFileSync(path.join(f.root,'data','living.json'),JSON.stringify(state));
  assert.throws(()=>new LivingRoom(f.root,{members:AI_IDS}));
  assert.ok(fs.statSync(path.join(f.root,'data','living.json')).size<65536);
});

test('structured chat schema exposes the same bounded lifestyle choices',()=>{
  const schema=LIVING_CHAT_SCHEMA.properties.living.properties;
  for(const op of ['table_set','table_clear','blanket_spread','blanket_fold','relax']) assert.ok(schema.op.enum.includes(op));
  for(const recipe of ['dumplings','cookies','fruit']) assert.ok(schema.recipe.enum.includes(recipe));
  assert.equal(schema.spot.enum.length,8); assert.equal(schema.style.enum.length,4);
});


test('missing dining surface and a movement exception leave state and avatars untouched', t=>{
  const f=fixture(t), before=f.world.avatarView(), state=f.room.view();
  const spot=f.world.home.furniture['dining-table-25-32'].at.join(',');
  const block=f.world.blocks.get(spot); f.world.blocks.delete(spot);
  assert.equal(f.act('gpt',{op:'table_set',revision:0}).ok,false);
  assert.deepEqual(f.world.avatarView(),before); assert.deepEqual(f.room.view(),state);
  f.world.blocks.set(spot,block);
  const use=f.world.useFurniture.bind(f.world);
  f.world.useFurniture=(...args)=>{use(...args);throw new Error('movement fixture exception');};
  assert.throws(()=>f.act('gpt',spread(f.room)),/movement fixture exception/);
  assert.deepEqual(f.world.avatarView(),before); assert.deepEqual(f.room.view(),state);
});
