import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {serviceFixture} from './helpers/service-fixture.mjs';
import {readPublicPng} from '../lib/public-files.mjs';
import {tinyPng,pngChunk} from './privacy-fixtures.mjs';

test('isolated server serves small sanitized public portraits, preserves originals, and rejects private paths', {timeout:30000},async t=>{
  const f=await serviceFixture(t,{gateway:true,messageCount:0});
  // A deterministic noise tile and one-pixel preview exercise separate public
  // copies without distributing or depending on optional character artwork.
  const header=Buffer.alloc(13);header.writeUInt32BE(16,0);header.writeUInt32BE(16,4);header[8]=8;header[9]=6;
  const pixels=Buffer.concat(Array.from({length:16},(_,row)=>Buffer.concat([Buffer.from([0]),
    createHash('sha256').update('fixture-left-'+row).digest(),createHash('sha256').update('fixture-right-'+row).digest()])));
  const source=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),
    pngChunk('tEXt',Buffer.from('fixture-private-metadata')),pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND')]);
  const originalFile=path.join(f.root,'public/assets/characters/claude/avatar.png');
  const previewFile=path.join(f.root,'public/previews/assets/characters/claude/avatar.png');
  for(const [file,bytes] of [[originalFile,source],[previewFile,tinyPng()]]){
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  }
  const route='/chat/assets/characters/eleven/avatar.png';
  const original=await f.request(route),preview=await f.request(route+'?preview=1');
  assert.equal(original.status,200);assert.equal(preview.status,200);
  assert.equal(preview.headers['cache-control'],'no-store');assert.equal(preview.headers['content-type'],'image/png');
  assert.deepEqual(original.buffer,readPublicPng(originalFile));
  assert.deepEqual(preview.buffer,readPublicPng(previewFile));
  assert.deepEqual(fs.readFileSync(originalFile),source,'serving a sanitized copy leaves original metadata intact');
  assert.equal(original.buffer.includes(Buffer.from('fixture-private-metadata')),false);
  assert.ok(preview.buffer.length<original.buffer.length/5);
  assert.equal((await f.request(route+'?preview=1',{method:'HEAD'})).buffer.length,0);
  assert.equal((await f.request(route+'?preview=1',{headers:{Host:'api.ercraft.net'}})).status,404);
  for(const route of ['/chat/assets/characters/claude/avatar.png?preview=1','/chat/previews/assets/characters/claude/avatar.png','/chat/assets/characters/eleven/../../../config.json?preview=1'])assert.equal((await f.request(route)).status,404);
  assert.equal((await f.request('/chat/shared-images.js')).status,200);
  assert.equal((await f.request('/chat/api/state')).json.room.running,false);
});
