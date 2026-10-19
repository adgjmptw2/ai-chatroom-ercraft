import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createPublicIdentity, publicId, internalMemberId, resolveCharacterAsset, NON_DISCLOSURE } from '../lib/public-identity.mjs';
import { createPublicWorkspace, publicPng, safePublicSource } from '../lib/public-files.mjs';
import { publicMember, publicMessage, publicEvent, publicPlans } from '../lib/public-view.mjs';
import { Store } from '../lib/store.mjs';
import { tinyPng, pngChunk } from './privacy-fixtures.mjs';

const privacy = createPublicIdentity({ agents: { gpt: {model:'custom-private-v9', boost:{model:'secret-tier-3'}} }, hive: { providerId:'secret-supplier', baseUrl:'https://private-router.example/v2' } });
const digest = value => createHash('sha256').update(value).digest('hex');
const leak = /claude|gpt|gemini|deepseek|grok|openai|anthropic|private-router|custom-private|secret-tier|secret-supplier|클로드|지피티|ジェミニ|ディープシーク/i;

test('public identity is fixed, reverse accepts only public IDs, aliases in multilingual speech are explicit redactions', () => {
  for (const [a,b] of Object.entries({claude:'eleven',gpt:'adina',deepseek:'lucia',gemini:'bianca',grok:'former-member',dev:'dev',user:'user',system:'system'})) {
    assert.equal(publicId(a),b); assert.equal(internalMemberId(b),a);
  }
  assert.equal(internalMemberId('claude'),null); assert.equal(internalMemberId('__proto__'),null);
  const normal='난 일레븐! 아디나랑 루치아, 비앙카랑 같이 차 마실래. ㅋㅋ';
  assert.equal(privacy.text(normal),normal);
  const text='Claude gpt-6.1-sol gemini-3.8-flash OpenAI 딥시크 클로드는 ジェミニの話 custom-private-v9 secret-tier-3 https://private-router.example/v2';
  assert.doesNotMatch(privacy.text(text),leak); assert.match(privacy.text(text),/\[비공개\]/);
  assert.doesNotMatch(privacy.text(text),/6\.1-sol|3\.8-flash/);
  assert.equal(privacy.text('오퍼스랑 오푸스, 챗GPT'), '[비공개]랑 [비공개], [비공개]');
});

test('recursive public views strip private metadata, remap IDs and reaction participants without mutating saved objects', () => {
  const source={id:7,from:'grok',by:'gpt',text:'OpenAI 클로드는 말했어. 평범한 대사는 유지.',
    reactions:{'👍':['claude','gpt','gemini','deepseek','grok'],OpenAI:['claude']},
    continuation:{owner:'deepseek',metadata:{model:'do-not-disclose',name:'custom-private-v9',myClaudeKey:'secret-tier-3'}},
    attach:{path:'images/claude-drawing.png',desc:'ディープシーク 그림',provider:'secret-supplier'}};
  const before=structuredClone(source);
  const result=publicMessage(source,'ko',privacy,()=> 'private-files/ERCraft-123.png');
  assert.equal(result.from,'former-member');assert.equal(result.by,'adina');
  assert.deepEqual(result.reactions['👍'],['eleven','adina','bianca','lucia','former-member']);
  assert.equal(result.continuation.owner,'lucia');assert.equal(result.continuation.metadata.model,undefined);
  assert.doesNotMatch(JSON.stringify(result),leak);assert.deepEqual(source,before);
  const member=publicMember({id:'deepseek',name:'루치아',aliases:['루치아','Lucia','deepseek','딥시크'],legacyAliases:['deepseek'],imageVision:false,imageGen:false,
    persona:{name:'루치아',privateInstructions:'private',skin:{full:'/assets/characters/deepseek/full.png',avatar:'/assets/characters/deepseek/full.png',avatarCrop:{x:.42,y:.08,width:.3,height:.3}}}},privacy);
  assert.deepEqual(member.aliases,['루치아','Lucia']);assert.equal(member.imageGen,undefined);assert.equal(member.legacyAliases,undefined);
  assert.equal(member.persona.skin.full,'/assets/characters/lucia/full.png');assert.equal(member.persona.skin.avatarCrop.x,.42);
  assert.equal(member.persona.privateInstructions,undefined);
  const collision=privacy.project({claude:{x:1},eleven:{x:2},'myClaudeKey':3});
  assert.equal(Object.keys(collision).length,3);assert.deepEqual(collision.eleven,{x:2});assert.doesNotMatch(JSON.stringify(collision),leak);
});

test('world block names and references are consistent across snapshots, geometry and definition events', () => {
  const source={custom:{claude_tile:{by:'claude',pixels:['aaaa'],colors:{a:'#ffffff'}},'private-block-existing':{by:'gpt'}},
    blocks:[[1,2,3,'claude_tile/stair/n'],[2,2,3,'private-block-existing']],
    signs:{'1,2,3':{by:'grok',text:'클로드 Gemini'}},avatars:{claude:{x:1},grok:{x:2}}};
  const before=structuredClone(source),out=privacy.world(source);
  const block=out.blocks[0][3].split('/')[0];assert.ok(out.custom[block]);assert.equal(out.custom[block].by,'eleven');
  assert.ok(out.custom[out.blocks[1][3]]);assert.equal(out.avatars['former-member'].x,2);
  assert.equal(publicEvent('world',{by:'gpt',changes:source.blocks},'ko',privacy).changes[0][3],out.blocks[0][3]);
  assert.deepEqual(publicEvent('worldblocks',source.custom,'ko',privacy),out.custom);
  assert.doesNotMatch(JSON.stringify(out),leak);assert.deepEqual(source,before);
  assert.doesNotMatch(JSON.stringify(publicPlans({plans:[{owner:'gpt',title:'custom-private-v9',stages:[{title:'OpenAI',metadata:{provider:'secret-supplier',text:'secret-tier-3'}}]}]},privacy)),leak);
});

test('lossless PNG public copies remove textual/compressed/provenance/trailing metadata and retain pixel/color/transparency chunks', () => {
  const color=pngChunk('gAMA',Buffer.from([0,0,177,143]));
  const rgba=tinyPng([color,pngChunk('tEXt',Buffer.from('Software\0OpenAI')),pngChunk('iTXt',Buffer.from('XMP\0Claude')),pngChunk('caBX',Buffer.from('OpenAI provenance')),pngChunk('zTXt',Buffer.from('compressed private metadata'))]);
  const original=Buffer.concat([rgba,Buffer.from('trailing OpenAI')]),before=digest(original);
  const copy=publicPng(original);
  assert.deepEqual(copy,tinyPng([color]));assert.equal(digest(original),before);assert.doesNotMatch(copy.toString('latin1'),/OpenAI|Claude|tEXt|iTXt|caBX|zTXt/);
  // Indexed-color PNG: PLTE/tRNS are byte-for-byte preserved as well.
  const palette=pngChunk('PLTE',Buffer.from([120,130,140])),alpha=pngChunk('tRNS',Buffer.from([128]));
  assert.deepEqual(publicPng(tinyPng([palette,alpha])),tinyPng([palette,alpha]));
  assert.throws(()=>publicPng(tinyPng([pngChunk('iCCP',Buffer.from('profile'))])));
  const corrupt=Buffer.from(rgba);corrupt[corrupt.length-1]^=1;assert.throws(()=>publicPng(corrupt));
  assert.throws(()=>publicPng(Buffer.from('not a PNG')));
});

test('conservative source scanning accepts safe drawings/miniapps unchanged and gates encoded identities or metadata', () => {
  for(const source of ['<svg xmlns="http://www.w3.org/2000/svg"><rect fill="pink" width="20" height="20"/></svg>', '<!doctype html><button>play</button>']) {
    assert.equal(safePublicSource(source,privacy),true);
  }
  for(const source of ['const myClaudeKey = 1;', 'const s="\\u004fpenAI";', '<text>&#67;laude</text>', '<text>Open&#x41;I</text>', '<metadata>neutral</metadata>', '<!ENTITY x "test">', 'const s="Clau" + "de";', 'atob("T3BlbkFJ")', '{"model":"custom-private-v9"}']) assert.equal(safePublicSource(source,privacy),false,source);
  for(const source of ['<svg><text><tspan>Open</tspan><tspan>AI</tspan></text></svg>', '<script>document.body.textContent=["Open","AI"].join("")</script>', '<button onclick="this.textContent=1">play</button>']) assert.equal(safePublicSource(source,privacy),false,source);
});

test('workspace aliases are deterministic, branded, collision-safe; both serving paths share policy and preserve originals', t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'chatroom-privacy-')); const store=new Store(home);
  t.after(()=>{assert.ok(path.basename(home).startsWith('chatroom-privacy-'));fs.rmSync(home,{recursive:true,force:true});});
  store.applyFileOp({op:'write',path:'OpenAI/Claude notes.txt',content:'클로드와 OpenAI. 평범한 내용.'},'claude');
  store.applyFileOp({op:'write',path:'safe.svg',content:'<svg xmlns="http://www.w3.org/2000/svg"><text>루치아</text></svg>'},'deepseek');
  store.applyFileOp({op:'write',path:'unsafe.svg',content:'<svg><metadata>OpenAI</metadata></svg>'},'gpt');
  store.applyFileOp({op:'write',path:'game.html',content:'<button>play</button>'},'gemini');
  store.applyFileOp({op:'write',path:'secret.js',content:'const model="claude";'},'gpt');
  fs.mkdirSync(store.abs('stickers/claude'),{recursive:true});
  fs.writeFileSync(store.abs('stickers/claude/hello.png'),tinyPng());
  const ws=createPublicWorkspace(store,privacy),alias=ws.publicPath('OpenAI/Claude notes.txt');
  assert.match(alias,/^private-files\/ERCraft-[a-f0-9]{64}\.txt$/);
  store.applyFileOp({op:'write',path:alias,content:'collision decoy'},'user');
  const hashes=()=>Object.fromEntries(store.listFiles().map(f=>[f.path,digest(fs.readFileSync(store.abs(f.path)))]));const before=hashes();
  const listing=ws.list();assert.equal(new Set(listing.map(f=>f.path)).size,listing.length);
  const sticker=listing.find(f=>f.sticker);assert.equal(sticker.stickerOwner,'eleven');assert.equal(sticker.available,true);assert.match(sticker.path,/^private-files\/ERCraft-/);
  assert.equal(listing.find(f=>f.path==='unsafe.svg').available,false);assert.equal(listing.find(f=>f.path==='secret.js').size,null);
  assert.equal(ws.read(alias).value.text,`${NON_DISCLOSURE}와 ${NON_DISCLOSURE}. 평범한 내용.`);
  assert.equal(ws.read(alias).value.meta.by,'eleven');assert.throws(()=>ws.read('OpenAI/Claude notes.txt'));
  assert.throws(()=>ws.read('unsafe.svg'));assert.throws(()=>ws.read('secret.js'));
  assert.equal(ws.read('safe.svg').body.toString(),store.readFile('safe.svg').text);
  assert.equal(ws.read('game.html').body.toString(),store.readFile('game.html').text);
  assert.equal(createPublicWorkspace(store,privacy).publicPath('OpenAI/Claude notes.txt'),alias);
  store.applyFileOp({op:'write',path:'safe.svg',content:'<svg>OpenAI</svg>'},'gpt');assert.throws(()=>ws.read('safe.svg'),'cache must recheck changed content');
  assert.equal(hashes()['OpenAI/Claude notes.txt'],before['OpenAI/Claude notes.txt']);
  assert.equal(hashes()['game.html'],before['game.html']);
});

test('character resolver only accepts fixed public paths and retains internal asset locations', () => {
  assert.equal(resolveCharacterAsset('/assets/characters/eleven/full.png'),'assets/characters/claude/full.png');
  assert.equal(resolveCharacterAsset('/assets/characters/lucia/full.png'),'assets/characters/deepseek/full.png');
  for(const value of ['/assets/characters/claude/full.png','/assets/characters/manifest.json','/assets/characters/eleven/../../config.json','/avatars/claude.svg'])assert.equal(resolveCharacterAsset(value),null);
});
