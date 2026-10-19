import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadImageAliases} from '../lib/image-aliases.mjs';
test('image aliases accept exact old image names and reject arbitrary paths or chains', t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'chatroom-image-alias-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(home)),path.resolve(os.tmpdir()));assert.ok(path.basename(home).startsWith('chatroom-image-alias-'));fs.rmSync(home,{recursive:true,force:true});});
 assert.equal(loadImageAliases(home).size,0);
 fs.mkdirSync(path.join(home,'data'));
 const file=path.join(home,'data/image-aliases.json'),old='images/gpt-20261001-160001.png',next='images/ERCraft-20261001-160001.png';
 fs.writeFileSync(file,JSON.stringify({[old]:next}));
 const aliases=loadImageAliases(home);assert.equal(aliases.get(old),next);assert.equal(aliases.get('images/other.png'),undefined);
 for(const value of [null,[],{[old]:'../data/admin-password.txt'},{[old]:'/absolute.png'},{[old]:old},{'images/':next},{[old]:'images/ERCraft-20261001-160001.html'}]){
  fs.writeFileSync(file,JSON.stringify(value));assert.throws(()=>loadImageAliases(home));
 }
});
