import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRoom, publicMember, publicMessage, publicPlans, batteryView, sleepStates, publicEvent } from '../lib/public-view.mjs';

test('public room/member/message/plan metadata excludes administrator and account fields', () => {
  const source = { running:false,sleeping:false,roomName:'ERCraft 단톡방',userName:'ERCraft',lang:'ko',calls:900,speed:'fast',autoSleepMin:20,boostMode:'auto' };
  assert.deepEqual(Object.keys(publicRoom(source)),['running','sleeping','roomName','userName','lang']);
  const member=publicMember({id:'claude',name:'일레븐',status:'idle',model:'private-model',maker:'private-provider',calls:999,lastMs:700,boostModel:'private-route',lastError:'private-secret'});
  assert.deepEqual(member,{id:'eleven',name:'일레븐',status:'idle'});
  const raw={id:1,ts:1,from:'claude',text:'내 말투는 그대로! ㅋㅋ',model:'private-model',boostWhy:'private-reason',attach:{path:'images/a.svg',desc:'그림',model:'private-model'}};
  const snapshot=structuredClone(raw),message=publicMessage(raw);
  assert.equal(message.text,raw.text);assert.equal(message.model,undefined);assert.equal(message.attach.model,undefined);assert.deepEqual(raw,snapshot);
  const plans=publicPlans({limits:{maxPerDay:24,used:4},pending:false,queue:{reason:'private'},plans:[{id:'1',title:'집',status:'draft',error:'private-error',brief:'internal brief',nextStage:1}]});
  assert.deepEqual(plans,{pending:false,plans:[{id:'1',title:'집',status:'draft',nextStage:1}]});
  assert.equal(publicEvent('usage',{private:'billing'}),null);
  assert.equal(publicEvent('internal',{secret:1}),null);
});

test('administrator battery detail keeps coarse states; public quota events are suppressed', () => {
  const now=10000000;
  const view=batteryView({a:{ok:true,at:now,windows:[{remainingPct:87.7},{remainingPct:42.8},{remainingPct:1,minor:true}]},
    b:{ok:true,at:now,windows:[{remainingPct:0}]},c:{ok:false,at:now,windows:[{remainingPct:70}]},d:{windows:[]},e:{ok:false}},['a','b','c','d','e'],now);
  assert.deepEqual(view,{a:{level:2,state:'ready'},b:{level:0,state:'ready'},c:{level:null,state:'stale'},d:{level:null,state:'unknown'},e:{level:null,state:'error'}});
  assert.doesNotMatch(JSON.stringify(view),/87|42|remaining|window|reset|plan|calls/);
  assert.deepEqual(batteryView({a:{ok:true,at:now-21*60000,windows:[{remainingPct:80}]}},['a'],now).a,{level:null,state:'stale'});
  assert.equal(publicEvent('batteries', view), null);
  const sleep = sleepStates([{ id: 'gpt', status: 'sleeping' }, { id: 'claude', status: 'idle' }]);
  assert.deepEqual(sleep, { adina: { state: 'asleep' }, eleven: { state: 'awake' } });
  assert.doesNotMatch(JSON.stringify(sleep), /level|window|reset|usage/);
});

test('system notices are polite without editing saved messages or character dialogue', () => {
  const error={id:2,from:'system',kind:'error',text:'다른 설계 요청을 처리 중이야.',planError:{code:'planner_busy',retryAfterSec:892},model:'secret'};
  const output=publicMessage(error);
  assert.match(output.text,/다른 설계 요청을 처리하고 있습니다/);assert.equal(output.planError,undefined);assert.equal(error.text,'다른 설계 요청을 처리 중이야.');
  assert.equal(publicMessage({from:'claude',text:'다른 설계 요청을 처리 중이야.'}).text,'다른 설계 요청을 처리 중이야.');
  const queued=publicMessage({from:'system',kind:'world',text:'📐 #2 집 · 설계 요청 접수 · 대기 1번. 차례가 오면 자동으로 설계해. 다시 요청할 필요는 없어.'});
  assert.equal(queued.text,'📐 #2 집 · 설계 요청 접수 · 대기 1번.');
  assert.equal(publicMessage({from:'system',kind:'info',text:'📐 #2 집 · 설계 요청 접수 · 대기 1번. 차례가 되면 자동으로 설계합니다. 다시 요청하지 않으셔도 됩니다.'}).text,queued.text);
  const duplicate=publicMessage({from:'system',kind:'info',text:'#1 집: 이미 완료한 단계야. 새 블록 0칸. 다음은 2단계, 25초 뒤 stage:"next"를 선택해.'});
  assert.match(duplicate.text,/이미 완료된 단계입니다/);assert.match(duplicate.text,/25초 후 다음 단계를 진행할 수 있습니다/);
  assert.doesNotMatch(duplicate.text,/단계야|선택해/);
  assert.doesNotMatch(publicMessage({from:'system',kind:'deep',text:'🔥 일레븐 진심모드 — secret-model · api-key'}).text,/secret|api-key/);
});
