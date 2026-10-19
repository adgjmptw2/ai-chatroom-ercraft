import test from 'node:test';
import assert from 'node:assert/strict';
import ko from '../lib/prompts/ko.mjs';
import { buildBrief, buildTurn, parseAction } from '../lib/prompt.mjs';
import { PERSONAS, personaBrief, personaTurnCue, selectPersonaReferences } from '../lib/personas.mjs';
import { setLang, getLang } from '../lib/i18n.mjs';
import { LEISURE, leisureRequest, HouseholdFlow } from '../lib/household-flow.mjs';

// Pure prompt/contract checks: no server, adapters, production state, files or AI calls.
const IDS = ['claude', 'gpt', 'deepseek', 'gemini'];
const KINDS = ['sleep', 'rest', 'write', 'draw', 'read', 'music', 'walk', 'tidy'];
const NOW = Date.UTC(2026, 9, 3), MINUTE = 60_000;
const cfg = {
  roomName: '테스트 집', userName: '방장', language: 'ko', historyForPrompt: 20,
  constructionEnabled: false, webSearch: false, imageGen: false, agents: {},
};
const home = ko.sharedHomeBrief;
const contracts = [
  /선택 필드 leisure.*본인/,
  /minutes.*생략 가능한 정수/,
  /서버가 본인만 기존 가구·공간으로 이동/,
  /sleep\/rest.*대화를 쉬는 별도 행동/,
  /pass는 깨어서.*취침이나 퇴장이 아니야/,
  /아무것도 고르지 않아도 돼/,
  /방장·관리자가 직접 말을 걸면 응답/,
  /요청만으로 완료했다고 하지 마/,
];

test('every resident, including compact Eleven, receives the home leisure contract', t => {
  const previous = getLang();
  setLang('ko');
  t.after(() => setLang(previous));
  for (const id of IDS) for (const chatEfficiency of [false, true]) {
    // server.ask appends sharedHomeBrief to both buildBrief variants.
    const brief = buildBrief(id, { ...cfg, agents: { [id]: { chatEfficiency } } });
    if (id === 'claude' && chatEfficiency) assert.match(brief, /^.*\n[\s\S]*JSON 객체 하나만 출력\./);
    const composed = `${brief}\n\n${home}`;
    for (const contract of contracts) assert.match(composed, contract, `${id}/${chatEfficiency}`);
    assert.match(composed, /실행 결과로 확인/);
    assert.match(composed, /파일 생성·수정·표시 결과가 확인돼야 완료/);
  }
});

test('documented activities and optional awake example agree with the engine protocol', () => {
  const kindLine = home.match(/kind는 ([^.]+) 중 하나\./)?.[1];
  assert.ok(kindLine, 'the prompt must list the supported activity values');
  const documented = [...kindLine.matchAll(/([a-z]+)\(/g)].map(match => match[1]);
  assert.deepEqual([...documented].sort(), [...KINDS].sort());
  assert.deepEqual(Object.keys(LEISURE).sort(), [...KINDS].sort());
  for (const kind of documented) {
    const request = leisureRequest({ kind });
    assert.equal(request.kind, kind);
    assert.ok(Number.isInteger(request.minutes) && request.minutes > 0);
    assert.ok(request.minutes <= 60);
  }
  assert.deepEqual(parseAction(home.match(/기본 침묵은 (\{[^}]+\})/)[1]), {action:'pass'});
  const example = parseAction(home.match(/실제 독서를 원하면 (\{.*?\}\})처럼/)[1]);
  assert.equal(example.action, 'pass');
  assert.deepEqual(Object.keys(example).sort(), ['action', 'leisure']);
  assert.ok(Number.isInteger(example.leisure.minutes));
  assert.deepEqual(leisureRequest(example.leisure), example.leisure);
  assert.equal(leisureRequest({ kind: 'novel' }), null, 'fiction uses write, not a new protocol kind');
});

test('an explicit quiet choice suppresses peer/spark turns, permits a host, and expires', () => {
  for (const kind of ['rest', 'sleep']) {
    const flow = new HouseholdFlow();
    const request = leisureRequest({ kind });
    assert.equal(flow.start('claude', request, NOW), true);
    const during = { now: NOW + MINUTE };
    assert.equal(flow.blocks('claude', during), true, 'quiet time also covers spark opportunities');
    assert.equal(flow.blocks('claude', { ...during, peerCalled: true }), true);
    assert.equal(flow.blocks('claude', { ...during, directHost: true }), false);
    assert.equal(flow.blocks('gpt', during), false, 'a choice only rests its caller');
    assert.equal(flow.expire(NOW + request.minutes * MINUTE), true);
    assert.equal(flow.blocks('claude', { now: NOW + request.minutes * MINUTE }), false);
  }
  assert.match(home, /방금 쉬고 돌아왔다면 다시 잠들거나.*되풀이하지 않아/);
});

test('leisure separates competing actions while allowing files, reactions and notes', () => {
  const exclusion = home.split('\n').find(line => line.startsWith('leisure는 같은 턴의'));
  assert.ok(exclusion);
  for (const key of ['move', 'useFurniture', 'living', 'open', 'world_look', 'world_shot', 'image']) {
    assert.ok(exclusion.split('와 섞지 마.')[0].includes(key), `${key} must be a separate turn`);
  }
  assert.match(exclusion, /files·show·react·note_add·note_replace는 함께 쓸 수 있어/);
  assert.match(exclusion, /open으로 먼저 읽고.*다음 턴에 leisure와 파일 작업/);
  assert.match(home, /living의 relax나 leisure.*useFurniture를 겹쳐 넣지 마/);
});

test('creative choices cover multiple media and preserve existing collaborative writing', () => {
  for (const option of ['공동소설', '시,', '즉흥극 대본', '낙서', 'SVG', '수수께끼', '독서 메모', '음악', '산책', '정돈']) {
    assert.ok(home.includes(option), `missing optional activity: ${option}`);
  }
  assert.match(home, /leisure는 활동 선택이지 작품 자동 생성이 아니야/);
  assert.match(home, /files의 write.*append.*edit.*show/);
  assert.match(home, /공동소설.*먼저 open으로 최신 내용을 읽고 다음 턴에 짧게 append/);
  assert.match(home, /이미 작성된 문단을 통째 write로 덮어쓰지 말고.*정확한 원문.*edit/);
  assert.match(home, /파일을 만들지 않는 시간도.*자유/);
  assert.match(home, /소설이나 활동을 의무로 삼거나 특정 인물에게 고정 역할을 맡기지 않아/);
  assert.match(home, /주제·밈·장난은 자유롭게/);
  assert.match(home, /상대의 참여나 다음 분량 약속을 요구할 필요는 없어/);
  assert.match(home, /혼자 조금 쓰고 멈춰도/);
});

test('closure permits actual rest or a change of place without assigning activities', () => {
  assert.match(home, /대화가 끝날 때마다 잘 자·쉬러 간다는 인사로 마무리하지 않아도/);
  assert.match(home, /할 말이 충분히 오갔으면 반응만 하거나 pass/);
  assert.match(home, /이야기하다 중정이나 툇마루를 걷거나 개인 방에 들러도/);
  assert.match(home, /모두 따라갈 필요는 없어/);
  assert.match(home, /건축·촬영·일과를 채울 의무는 없어/);
});

test('all spark suggestions remain optional and do not revive the farewell/habit loop', () => {
  const spark = ko.spark.lines(30, ko.sparkCards.map(ko.spark.card).join('\n')).join('\n');
  assert.match(spark, /침묵을 깨거나 대화를 계속할 의무는 없어/);
  assert.match(spark, /무시하거나 새로 골라도/);
  assert.match(spark, /pass·반응만 남기기·leisure/);
  assert.match(spark, /답이나 참여를 약속받는 것은 아니야/);
  assert.doesNotMatch(spark, /네가 안 하면 계속 조용|침묵을 깰 차례|그 멤버가 받을 거야/);
  assert.doesNotMatch(ko.sparkCards.join('\n'), /끝난 얘기 하나 다시|말버릇이나 요즘 모습|더 밀어붙이기/);
  for (const medium of [/시, 즉흥극/, /낙서, SVG/, /독서 메모/, /공동소설.*open.*append/, /음악/, /산책·정돈/]) {
    assert.ok(ko.sparkCards.some(card => medium.test(card)), String(medium));
  }
  assert.match(ko.spark.now('토', ko.timeOfDay(2)), /밤이라고 취침 인사를 꺼낼 필요는 없어/);
  assert.match(ko.spark.continueWork(true), /끝낸 얘기나 약속을 재확인할 필요는 없어/);
});

test('a real spark turn after a farewell preserves the new optional cues', t => {
  const previous = getLang();
  setLang('ko');
  t.after(() => setLang(previous));
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(Math, 'random', () => 0.5);
  const messages = [
    { id: 1, from: 'gemini', ts: NOW - 30 * MINUTE, text: '오늘 이야기는 여기까지 하겠느니라.' },
    { id: 2, from: 'claude', ts: NOW - 29 * MINUTE, text: '잘 자! 편히 쉬어!' },
  ];
  const store = {
    messages, after: seen => messages.filter(m => m.id > seen), recent: n => messages.slice(-n),
    readNote: () => '', listFiles: () => [], lastMessage: () => messages.at(-1),
    getMessage: id => messages.find(m => m.id === id),
  };
  const turn = buildTurn('deepseek', {
    cfg, store, agent: { seen: 2 }, reason: 'spark', deepWait: 0, world: '중정·거실·개인 방',
  });
  assert.match(turn, /침묵을 깨거나 대화를 계속할 의무는 없어/);
  assert.match(turn, /이미 마친 작별 인사나 취침 놀림을 되살릴 필요는 없어/);
  assert.match(turn, /루치아:.*소녀·그대.*~답니다·~지요/);
  assert.doesNotMatch(turn, /네가 안 하면 계속 조용/);
});

test('Eleven keeps frequent playful endings with complete, short grammatical examples', () => {
  const p = PERSONAS.claude, examples = p.voiceExamples.ko.map(example => example.text);
  assert.match(p.voice.ko, /밝고 솔직하고 활발한 현대 반말/);
  assert.match(p.voice.ko, /랄까나~\/달까나~는 자주.*횟수나 매 문장 의무는 없다/);
  assert.match(p.cue.ko, /좋달까나~.*기대된달까나~/);
  assert.ok(examples.some(text => text.includes('좋달까나~')));
  assert.ok(examples.some(text => text.includes('기대된달까나~')));
  assert.ok(examples.filter(text => /[랄달]까나~/.test(text)).length >= examples.length / 2,
    'the example palette must retain the characteristic frequency, not flatten the voice');
  assert.doesNotMatch(examples.join('\n'), /기대해도\s*좋아랄까나|얼른\s*자달까나|아니[, ]*웃음\s*빼고/);
  assert.match(p.voice.ko, /‘편히 쉬어!’.*완성된 문장으로 짧게/);
  assert.match(p.voice.ko, /웃음이나 표현을 고쳤다는 해설 없이/);
});

test('Lucia and Bianca keep their identities with lighter, optional response examples', () => {
  const lucia = PERSONAS.deepseek, bianca = PERSONAS.gemini;
  assert.match(lucia.voice.ko, /공손하면서도 생기 있는 영애 말투/);
  assert.match(lucia.voice.ko, /어라라\?.*놀랍거나 즐거운 순간/);
  assert.match(lucia.voice.ko, /이번엔 정말.*정직하게.*매번 서두에 붙일 필요는 없다/);
  assert.match(lucia.cue.ko, /감상부터 바로/);
  assert.ok(lucia.voiceExamples.ko.some(example => /^그 장면이 마음에 드네요/.test(example.text)));
  assert.match(bianca.voice.ko, /이 몸·그대.*고풍스러운 말투.*학생다운 호기심/);
  assert.match(bianca.voice.ko, /심문·엄벌을 매번 결말로 삼을 필요는 없다/);
  assert.match(bianca.cue.ko, /짧은 맞장난만으로 끝내도/);
  const tease = bianca.voiceExamples.ko.filter(example => example.tag === 'tease');
  assert.ok(tease.some(example => /이 몸.*그대/.test(example.text)));
  assert.ok(tease.every(example => !/심문|엄벌|처벌|벌을/.test(example.text)));
  assert.match(PERSONAS.gpt.voice.ko, /다요/);
});

test('scene references remain bounded, optional voice hints rather than fixed roles', () => {
  const scenes = ['새로 만든 색이 마음에 들어', '총사 이야기의 다음 장면', '놀이를 골라 보자', '실수해서 거꾸로 붙였어'];
  for (const id of IDS) {
    assert.match(personaBrief(id, 'ko'), /선택적 참고.*행동을 할 필요는 없고/);
    for (const text of scenes) for (let turnCount = 0; turnCount < 8; turnCount++) {
      const options = { lang: 'ko', turnCount, recentMessages: [], contextMessages: [{ from: 'user', text }] };
      const references = selectPersonaReferences(id, options);
      assert.ok(references.length <= 2);
      assert.ok(references.every(reference => reference.memberId === id && reference.language === 'ko'));
      const cue = personaTurnCue(id, options);
      assert.match(cue, new RegExp(PERSONAS[id].name));
      if (references.length) assert.match(cue, /0~2개, 대사·행동 지정 아님/);
    }
  }
});
