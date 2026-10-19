import test from 'node:test';
import assert from 'node:assert/strict';
import { homeVisible, buriedCube, opaqueCube, safeRoute, NEIGHBORS, HOME_CAMERAS } from '../public/world-home.js';
const home = { id:'mulgyeol-maru' };
test('interior cutaway keeps floors, furniture level and album wall, hides roof', () => {
  assert.equal(homeVisible(20,8,12,home),false);
  assert.equal(homeVisible(20,3,12,home),true);
  assert.equal(homeVisible(9,6,20,home),false);
  assert.equal(homeVisible(37,6,22,home),true);
  assert.equal(homeVisible(20,8,12,home,false),true);
  assert.equal(homeVisible(20,8,12,null),true);
  assert.equal(homeVisible(20,8,12,home,false,7),false);
});
test('culling never hides a cube exposed by cutaway, glass, door or furniture', () => {
  const blocks = new Map(NEIGHBORS.map(([x,y,z]) => [`${10+x},${3+y},${10+z}`,'stone']));
  const check = visible => buriedCube(10,3,10,'stone',blocks,{},visible);
  assert.equal(check(()=>true),true);
  assert.equal(check((x,y)=>y<=3),false);
  for(const value of ['glass','water','door/x','planks/chair/n']) {
    blocks.set('11,3,10',value); assert.equal(check(()=>true),false);
  }
  assert.equal(opaqueCube('veil',{veil:{clear:true}}),false);
});
test('camera presets bounded and route input capped', () => {
  assert.equal(Object.keys(HOME_CAMERAS).length,4);
  assert.deepEqual(safeRoute([{x:1,y:4,z:2},{x:NaN,y:1,z:2}]),[{x:1,y:4,z:2}]);
  assert.deepEqual(safeRoute(Array(2305).fill({x:1,y:4,z:2})),[]);
});
