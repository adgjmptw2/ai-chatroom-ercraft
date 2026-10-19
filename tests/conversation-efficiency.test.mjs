import test from 'node:test';
import assert from 'node:assert/strict';
import { efficientConversation, selectConversationHistory, scheduleConversationRead, conversationPriority, BubblePacer } from '../lib/conversation-efficiency.mjs';
import { buildBrief, buildTurn } from '../lib/prompt.mjs';
import { takeParticipationTurn, formatMemberSpeech } from '../lib/member-speech.mjs';
import { personaBrief } from '../lib/personas.mjs';
import { setLang } from '../lib/i18n.mjs';
import ko from '../lib/prompts/ko.mjs';

setLang('ko');
test('slow pacing applies to host requests and coalesced peer mentions without moving the first deadline', () => {
  const peer = { id: 'claude' }, t = 100000;
  for (let i = 0; i < 8; i++) scheduleConversationRead(peer, [{ id: i + 1, from: 'gpt' }], t + i * 8000,
    { urgent: true, quietDelayMs: 30000, maxWaitMs: 75000 });
  assert.equal(peer.wakeAt, t + 75000);
  const host = { id: 'gemini' };
  scheduleConversationRead(host, [{ id: 1, from: 'user' }], t, { directHost: true, hostDelayMs: 16000 });
  assert.equal(host.wakeAt, t + 16000);
  scheduleConversationRead(host, [{ id: 2, from: 'gpt' }], t + 1000, { urgent: true, quietDelayMs: 50000 });
  assert.equal(host.wakeAt, t + 16000, 'peer bursts cannot postpone the pending host reply');
});

test('concurrent completed replies are spaced globally; stopping cancels a waiting bubble', async () => {
  const p = new BubblePacer(), pending = [], times = [];
  let clock = 0, running = true;
  const options = { now: () => clock, gapMs: () => 12000, active: () => running,
    sleep: () => new Promise(resolve => pending.push(resolve)) };
  const turns = [0, 1, 2].map(async () => { if (await p.wait(options)) times.push(clock); });
  await Promise.resolve();
  assert.deepEqual(times, [0]);
  clock = 12000; pending.splice(0).forEach(resolve => resolve());
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(times, [0, 12000]);
  running = false; pending.splice(0).forEach(resolve => resolve());
  await Promise.all(turns);
  assert.deepEqual(times, [0, 12000]);
});

test('priority requires unread peer content and bounded quiet time, never system-only or empty activity', () => {
 const a = { lastEnd: 100000, readBatch: {firstAt:100000} };
 assert.equal(conversationPriority(a,159999,{peerCalled:true,peerUnread:true}),false);
 assert.equal(conversationPriority(a,160000,{peerCalled:true,peerUnread:true}),true);
 assert.equal(conversationPriority(a,249999,{peerUnread:true}),false);
 assert.equal(conversationPriority(a,250000,{peerUnread:true}),true);
 assert.equal(conversationPriority(a,300000,{}),false);
 assert.equal(conversationPriority({...a,readBatch:{firstAt:249000}},250000,{peerUnread:true}),false);
});
const cfg = () => ({ language: 'ko', roomName: '테스트방', userName: '방장', historyForPrompt: 40,
  constructionEnabled: false, webSearch: false, agents: { claude: { model: 'sonnet', effort: 'low', chatEfficiency: true,
    boost: { model: 'opus' } }, deepseek: {} } });
const message = (id, from = 'gpt', text = `일상 이야기 ${id}`) => ({ id, from, text, ts: Date.now() - (70 - id) * 1000 });
function fixture(messages = []) {
  return { messages, recent: n => messages.slice(-n), after: n => messages.filter(m => m.id > n),
    getMessage: id => messages.find(m => m.id === id), lastMessage: () => messages.at(-1),
    readNote: () => '약속은 목요일. 취소하지 않았음.', listFiles: () => [], readFile: () => { throw Error('not expected'); } };
}

test('opt-in is specific to Eleven; other members retain their complete normal window', () => {
  const c = cfg(), store = fixture(Array.from({ length: 60 }, (_, i) => message(i + 1)));
  assert.equal(efficientConversation('claude', c), true);
  assert.equal(efficientConversation('deepseek', c), false);
  assert.equal(efficientConversation('claude', { agents: {} }), false);
  assert.deepEqual(selectConversationHistory(store, 'claude', c, 60, []), store.recent(12));
  const optedOut = { ...c, agents: { ...c.agents, claude: { ...c.agents.claude, chatEfficiency: false } } };
  assert.deepEqual(selectConversationHistory(store, 'claude', optedOut, 60, []), store.recent(40));
  assert.deepEqual(selectConversationHistory(store, 'gpt', c, 60, []), store.recent(40));
});

test('unread messages, older host requests and reply parents survive the smaller history', () => {
  const messages = Array.from({ length: 60 }, (_, i) => message(i + 1));
  messages[4] = { ...message(5, 'user', '@일레븐 약속 기억해?'), replyTo: 2 };
  messages[59].replyTo = 1;
  const before = structuredClone(messages), store = fixture(messages);
  const selected = selectConversationHistory(store, 'claude', cfg(), 4, store.after(4));
  for (const id of [1, 2, 5, ...Array.from({ length: 40 }, (_, i) => i + 21)]) assert.ok(selected.some(m => m.id === id), `missing ${id}`);
  assert.deepEqual(messages, before);
  assert.equal(new Set(selected.map(m => m.id)).size, selected.length);
});

test('reply parents just outside the smaller tail survive for both seen and unread replies', () => {
  const messages = Array.from({ length: 60 }, (_, i) => message(i + 1));
  messages[49].replyTo = 47;
  messages[59].replyTo = 48;
  const store = fixture(messages), before = structuredClone(messages);
  const selected = selectConversationHistory(store, 'claude', cfg(), 58, store.after(58));
  assert.deepEqual(selected.map(m => m.id), [47, 48, ...Array.from({ length: 12 }, (_, i) => i + 49)]);
  assert.deepEqual(messages, before);
});

test('history shrink honors the outer prompt limit and preserves untouched message text', () => {
  const messages = Array.from({ length: 60 }, (_, i) => message(i + 1));
  const store = fixture(messages);
  const selected = selectConversationHistory(store, 'claude', { ...cfg(), historyForPrompt: 8 }, 60, []);
  assert.equal(selected.length, 8);
  assert.strictEqual(selected.at(-1), messages.at(-1));
});

test('peer bursts wait 15 seconds with a firm 40-second deadline; no unread state is consumed', () => {
  const a = { seen: 10 }, now = 100000;
  scheduleConversationRead(a, [message(11)], now);
  assert.equal(a.wakeAt, now + 15000);
  scheduleConversationRead(a, [message(11)], now + 1000);
  assert.equal(a.wakeAt, now + 15000);
  const deadlines = [23000, 31000, 39000, 40000, 40000];
  for (let i = 1; i <= deadlines.length; i++) {
    scheduleConversationRead(a, [message(11 + i)], now + i * 8000, { urgent: true });
    assert.equal(a.wakeAt, now + deadlines[i - 1]);
    assert.equal(a.readBatch.firstAt, now);
    assert.equal(a.seen, 10);
  }
});

test('host request preempts batching and later peer activity cannot postpone it', () => {
  const a = {}, now = 100000;
  scheduleConversationRead(a, [message(1)], now);
  scheduleConversationRead(a, [message(2, 'user')], now + 1000, { directHost: true, hostDelayMs: 1000 });
  assert.equal(a.wakeAt, now + 2000);
  scheduleConversationRead(a, [message(3)], now + 1500);
  assert.equal(a.wakeAt, now + 2000);
  scheduleConversationRead(a, [message(4, 'user')], now + 1800, { directHost: true, hostDelayMs: 3000 });
  assert.equal(a.wakeAt, now + 2000);
  assert.equal(a.reason, 'urgent');
});

test('a late host request keeps an earlier peer deadline', () => {
  const a = {}, now = 100000;
  scheduleConversationRead(a, [message(1)], now);
  scheduleConversationRead(a, [message(2)], now + 14000);
  scheduleConversationRead(a, [message(3)], now + 28000);
  assert.equal(a.wakeAt, now + 40000);
  scheduleConversationRead(a, [message(4, 'user')], now + 39000, { directHost: true, hostDelayMs: 3000 });
  assert.equal(a.wakeAt, now + 40000);
  assert.equal(a.reason, 'urgent');
});

test('the 0.45 participation rate is retained and direct host calls do not consume peer credit', () => {
  const state = {};
  let calls = 0;
  for (let i = 0; i < 100; i++) {
    calls += takeParticipationTurn(state, .45);
    const credit = state.participationCredit;
    assert.equal(takeParticipationTurn(state, .45, true), true);
    assert.equal(state.participationCredit, credit);
  }
  assert.ok(Math.abs(calls + state.participationCredit - 45) < 1e-12);
});

test('participation is 20 percent lower than the previous half rate; direct host calls bypass it', () => {
  const oldState = {}, nextState = {};
  let oldCalls = 0, nextCalls = 0;
  for (let i = 0; i < 100; i++) {
    oldCalls += takeParticipationTurn(oldState, .5);
    nextCalls += takeParticipationTurn(nextState, .4);
    const credit = nextState.participationCredit;
    assert.equal(takeParticipationTurn(nextState, .4, true), true);
    assert.equal(nextState.participationCredit, credit);
  }
  assert.equal(oldCalls, 50); assert.equal(nextCalls, 40);
});

test('compact brief reduces recurrent input while retaining voice, privacy and living/workspace abilities', () => {
  const c = cfg(), compact = buildBrief('claude', c, { canSee: true });
  const full = buildBrief('claude', { ...c, agents: { ...c.agents, claude: { ...c.agents.claude, chatEfficiency: false } } }, { canSee: true });
  assert.ok(compact.length < full.length * .85, `${compact.length} vs ${full.length}`);
  assert.ok(compact.includes(personaBrief('claude')));
  assert.ok(compact.includes(ko.identityPrivacy));
  for (const key of ['messages', 'react', 'reply_to', 'files', 'show', 'open', 'sticker', 'sticker_save', 'move', 'useFurniture', 'world_shot', 'world_look', 'note_add', 'note_replace', 'boost']) {
    assert.ok(compact.includes(`"${key}"`), key);
  }
  assert.doesNotMatch(compact, /"build"|"plan_request"|"image"|sonnet|opus/);
  const building = { ...c, constructionEnabled: true };
  assert.ok(buildBrief('claude', building).includes('"plan_request"'));
  assert.ok(buildBrief('claude', c, { mode: 'off' }).includes('"boost"') === false);
});

test('irrelevant automatic file bodies are omitted, but their names and explicit open remain available', () => {
  const messages = Array.from({ length: 50 }, (_, i) => message(i + 1));
  const store = fixture(messages), marker = 'UNRELATED_FILE_BODY';
  store.listFiles = () => [{ path: 'old.svg', size: 7000, by: 'gpt', mtime: Date.now() }];
  store.isImage = () => false;
  store.readFile = () => ({ text: marker.repeat(500) });
  const context = { store, cfg: cfg(), agent: { seen: 49 }, reason: 'new', deepWait: 0 };
  const ordinary = buildTurn('claude', context);
  assert.ok(ordinary.includes('old.svg'));
  assert.ok(!ordinary.includes(marker));
  assert.ok(ordinary.includes(store.readNote()));
  const explicit = 'OPENED_COMPLETE_CONTENT'.repeat(300);
  assert.ok(buildTurn('claude', { ...context, openFile: { rel: 'old.svg', text: explicit } }).includes(explicit));
  messages.at(-1).text = 'old.svg의 색 어때?';
  const relevant = buildTurn('claude', context);
  assert.ok(relevant.includes(marker));
  assert.ok(!relevant.includes(marker.repeat(100)));
  assert.equal(store.readFile().text.length, marker.repeat(500).length);
});

test('natural Eleven endings pass through unchanged and no suffix is fabricated', () => {
  for (const speech of ['뜻밖의 발견이랄까나.', '욕심 좀 부렸달까나.', '오늘은 조용히 있고 싶어.'])
    assert.equal(formatMemberSpeech('claude', speech), speech);
});
