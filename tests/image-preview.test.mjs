import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {ImagePreviews,renderPreview,previewKey,safePreview} from '../lib/image-preview.mjs';
import {publicPng} from '../lib/public-files.mjs';
import {tinyPng,pngChunk} from './privacy-fixtures.mjs';
import {serviceFixture} from './helpers/service-fixture.mjs';
const base=import.meta.dirname;
function directory(t){const dir=fs.mkdtempSync(path.join(base,'.preview-test-'));t.after(()=>{assert.equal(path.dirname(dir),base);assert.ok(path.basename(dir).startsWith('.preview-test-'));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
const tiny=publicPng(tinyPng());
const jpeg=await renderPreview(tiny);

test('real renderer downsizes PNG pixels, produces metadata-free JPEG and leaves original unchanged',async t=>{
  const width=1200,height=900,header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height);let seed=19;
  for(let y=0;y<height;y++)for(let x=1;x<=width*3;x++){seed=(seed*1664525+1013904223)>>>0;pixels[y*(width*3+1)+x]=seed>>>24;}
  const original=Buffer.concat([tiny.subarray(0,8),pngChunk('IHDR',header),pngChunk('tEXt',Buffer.from('Software\0private-provider')),pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND')]);
  const before=Buffer.from(original),clean=publicPng(original),cache=new ImagePreviews(directory(t));
  const preview=await cache.get(clean);assert.ok(safePreview(preview));assert.ok(preview.length<clean.length/5);assert.deepEqual(original,before);
  assert.equal(preview.includes(Buffer.from('private-provider')),false);
  assert.equal(cache.busy,false);
});
test('same content shares work, different photos convert serially and disk reuse does not launch another converter',async t=>{
  const dir=directory(t);let calls=0,active=0,maximum=0;
  const cache=new ImagePreviews(dir,{render:async()=>{calls++;active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,10));active--;return jpeg;}});
  const other=Buffer.concat([tiny,Buffer.from('other fixture key')]);
  const results=await Promise.all([cache.get(tiny),cache.get(tiny),cache.get(other)]);
  assert.equal(calls,2);assert.equal(maximum,1);assert.deepEqual(results[0],results[1]);
  const restored=new ImagePreviews(dir,{render:()=>{throw Error('Must use derived disk cache');}});
  assert.deepEqual(await restored.get(tiny),jpeg);
});
test('failed conversion can retry; oversized dimensions and queue pressure are bounded',async t=>{
  let calls=0;const cache=new ImagePreviews(directory(t),{render:async()=>{if(!calls++)throw Error('temporary');return jpeg;}});
  await assert.rejects(cache.get(tiny),/temporary/);assert.equal(cache.busy,false);assert.deepEqual(await cache.get(tiny),jpeg);
  const huge=Buffer.from(tiny);huge.writeUInt32BE(5000,16);await assert.rejects(cache.get(huge),/unavailable/);assert.equal(calls,2);
  let release;const gate=new Promise(r=>release=r);const capped=new ImagePreviews(directory(t),{render:async()=>{await gate;return jpeg;}});
  const jobs=Array.from({length:16},(_,i)=>capped.get(Buffer.concat([tiny,Buffer.from(String(i))])));
  await assert.rejects(capped.get(Buffer.concat([tiny,Buffer.from('overflow')])),/queue busy/);
  release();await Promise.all(jobs);assert.equal(capped.busy,false);
});
test('cache refuses identifying JPEG segments, corrupt files and linked cache directories',async t=>{
  const comment=Buffer.from([0xff,0xfe,0,8,83,101,99,114,101,116]);
  assert.equal(safePreview(Buffer.concat([jpeg.subarray(0,2),comment,jpeg.subarray(2)])),false);
  const dir=directory(t);fs.writeFileSync(path.join(dir,previewKey(tiny)+'.jpg'),Buffer.from('bad'));
  await assert.rejects(new ImagePreviews(dir).get(tiny),/Invalid preview/);
  const parent=directory(t),target=directory(t),link=path.join(parent,'linked');fs.symlinkSync(target,link,'junction');
  await assert.rejects(new ImagePreviews(link).get(tiny),/cache unavailable/);fs.unlinkSync(link);
});
test('actual copied server serves preview from public bytes, retains original route, respects gateway and hides derived cache',async t=>{
  const f=await serviceFixture(t,{gateway:true,messageCount:0});
  const dir=path.join(f.home,'workspace/images');fs.mkdirSync(dir,{recursive:true});
  const original=tinyPng([pngChunk('tEXt',Buffer.from('Software\0private-provider'))]);
  fs.writeFileSync(path.join(dir,'preview.png'),original);
  const cache=new ImagePreviews(path.join(f.home,'data/image-previews-v1'),{render:async()=>jpeg});
  await cache.get(publicPng(original));
  const route='/chat/ws/images/preview.png';const result=await f.request(route+'?preview=1&t=1');
  assert.equal(result.status,200);assert.equal(result.headers['content-type'],'image/jpeg');assert.deepEqual(result.buffer,jpeg);
  assert.equal(result.headers['cache-control'],'no-store');assert.deepEqual((await f.request(route)).buffer,publicPng(original));
  assert.deepEqual(fs.readFileSync(path.join(dir,'preview.png')),original);
  assert.equal((await f.request(route+'?preview=1',{method:'HEAD'})).buffer.length,0);
  assert.equal((await f.request(route+'?preview=1',{headers:{Host:'api.ercraft.net'}})).status,404);
  assert.equal((await f.request('/chat/data/image-previews-v1/'+previewKey(tiny)+'.jpg')).status,404);
  assert.equal((await f.request('/chat/ws/../data/image-previews-v1/cache.jpg?preview=1')).status,404);
  assert.equal((await f.request('/chat/api/state')).json.room.running,false);
});
