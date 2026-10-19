import test from 'node:test';
import assert from 'node:assert/strict';
import {photocardWorldSnapshot,buildPhotocardPrompt} from '../lib/photocards.mjs';
test('request-time poses are copied without routing IDs and override invented seating while allowing illustration wardrobe',()=>{
 const subjects=[{id:'gpt',name:'아디나'},{id:'claude',name:'일레븐'},{id:'gemini',name:'비앙카'}];
 const avatars={gpt:{x:28,y:4.46,z:32,posture:'sit',furniture:{shape:'chair',private:'secret'}},claude:{x:22,y:4,z:34,posture:'stand'}};
 const snapshot=photocardWorldSnapshot(subjects,avatars,123);
 avatars.claude.posture='sit';avatars.gpt.x=0;
 assert.equal(snapshot.members[1].posture,'stand');assert.equal(snapshot.members[0].position[0],28);
 assert.equal(snapshot.members[2].posture,'unknown');assert.equal(snapshot.members[2].position,null);
 assert.doesNotMatch(JSON.stringify(snapshot),/gpt|claude|gemini|secret/);
 for(const shape of ['bench','table']) {
  avatars.gpt.furniture.shape=shape;
  assert.equal(photocardWorldSnapshot(subjects,avatars,123).members[0].furniture,shape);
 }
 const prompt=buildPhotocardPrompt({subjects,prompt:'모두 잠옷을 입고 앉아 있음',worldSnapshot:snapshot});
 assert.match(prompt,/Keep standing people standing/);assert.match(prompt,/Wardrobe variation is illustration styling only/);
 assert.match(prompt,/If no relevant outfit or occasion is supplied, retain the reference outfit/);
 assert.match(prompt,/never recolor hair or swap identities/);
 assert.ok(prompt.includes(JSON.stringify(snapshot)));
});

test('malformed or out-of-world positions do not imply presence, posture or furniture', () => {
 const subjects = [{id:'gpt',name:'Adina'}];
 for (const position of [[NaN,4,12],[12,Infinity,12],[-1,4,12],[48,4,12],[12,-1,12],[12,34,12],[12,4,48],['12',4,12]]) {
  const [x,y,z] = position;
  const result = photocardWorldSnapshot(subjects,{gpt:{x,y,z,posture:'sit',furniture:{shape:'chair'}}},123);
  assert.deepEqual(result.members,[{name:'Adina',position:null,posture:'unknown',furniture:null}]);
 }
});
