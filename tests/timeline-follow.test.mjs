import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// Exercise the real app callback, including the default latest-follow state.
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const options=source.slice(source.indexOf('const timeline = new TimelineWindow('),source.indexOf('let messageFrame;'));
test('one small upward wheel/arrow step releases latest-follow; downward motion only rejoins at bottom',()=>{
 const S={stuck:true,tail:null,unseen:3,messages:[]},tl={scrollHeight:9000,clientHeight:600};
 let callback;
 const c=vm.createContext({S,tl,msgsBox:{},buildMsg(){},TimelineWindow:class{constructor(o){callback=o.onScroll;}},
  renderJump(){},history:{armed:true},loadOlder(){},pruneLiveMessages(){},scheduleMessages(){},LIVE_MESSAGES:600});
 vm.runInContext(options,c);
 callback({top:8370,up:true,internal:false});assert.equal(S.stuck,false,'30px must not snap back');
 callback({top:8380,up:false,internal:false});assert.equal(S.stuck,false,'20px above bottom is still reading history');
 callback({top:8400,up:false,internal:false});assert.equal(S.stuck,true);assert.equal(S.unseen,0);
 S.stuck=false;callback({top:8400,up:false,internal:true});assert.equal(S.stuck,false,'layout adjustments do not override intent');
 S.tail=[{}];callback({top:8400,up:false,internal:false});assert.equal(S.stuck,false,'discontinuous history stays detached');
});
