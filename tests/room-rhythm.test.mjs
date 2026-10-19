import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomRhythm, repeatedConversation } from '../lib/room-rhythm.mjs';
import { CozyChatHints } from '../lib/cozy-chat.mjs';
import { World } from '../lib/world.mjs';
import { buildHouse } from '../lib/house.mjs';

const IDS = ['claude', 'gpt', 'deepseek', 'gemini'];
const NOW = Date.UTC(2026, 9, 3), M = 60_000;
function fixture(t) {
  const parent = path.dirname(fileURLToPath(import.meta.url));
  const root = fs.mkdtempSync(path.join(parent, '.rhythm-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent));
    assert.ok(path.basename(root).startsWith('.rhythm-fixture-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/world.json'), JSON.stringify(buildHouse()));
  const world = new World(root, IDS);
  const save = t.mock.method(world, 'save', () => {});
  t.mock.method(Date, 'now', () => NOW);
  for (const [i, actor] of IDS.entries()) {
    const at = world.home.furniture[`sofa-${i + 1}`].at;
    const { block, shape, ...pose } = world.furniturePose(at);
    world.avatars[actor] = { ...pose, furniture: { at: [...at], block, shape } };
  }
  const flow = new RoomRhythm();
  flow.observe(world, { active: true, now: NOW });
  return { world, flow, save };
}
function advance(f, minutes, { from = NOW, active = true } = {}) {
  for (let time = from + 1000; time <= from + minutes * M; time += 1000) {
    f.flow.observe(f.world, { active, now: time });
  }
  return from + minutes * M;
}
const echo = (count = 36) => Array.from({ length: count }, (_, i) => ({ id: i + 1,
  from: IDS[i % IDS.length], ts: NOW - (count - i) * 20_000,
  text: ['창가 자리에는 각설탕을 두겠어요.', '각설탕과 창가라니 낭만적이구나!',
    '창가 약속은 각설탕 하나로 기억할게.', '각설탕을 챙겨서 창가에서 기다릴 거야.'][i % 4] }));

test('detects sustained recurring premise even with differently worded replies; no writes to history', () => {
  const messages = echo(), before = structuredClone(messages);
  assert.equal(repeatedConversation(messages, NOW), true);
  assert.deepEqual(messages, before);
  assert.equal(repeatedConversation(echo(12), NOW), false);
  assert.equal(repeatedConversation(messages.map(m => ({ ...m, ts: NOW - m.id * 1000 })), NOW), false);
  assert.equal(repeatedConversation(messages, NOW + 60 * M), false);
});

test('host or developer instruction starts a fresh context and system text cannot trigger a loop', () => {
  for (const from of ['user', 'dev']) assert.equal(repeatedConversation([...echo(), { from, text: '그 얘기 계속해줘', ts: NOW }], NOW), false);
  assert.equal(repeatedConversation(echo().map(m => ({ ...m, from: 'system' })), NOW), false);
});

test('slow echoes across an hour are recognized while a finished old topic stays quiet',()=>{
 const slow=echo(24).map((m,i)=>({...m,ts:NOW-(24-i)*3*M}));
 assert.equal(repeatedConversation(slow,NOW),true);
 assert.equal(repeatedConversation(slow,NOW+30*M),false);
 assert.equal(repeatedConversation([...slow,{from:'user',text:'그 이야기 계속해줘',ts:NOW}],NOW),false);
});

test('character names, speech endings and a varied discussion do not constitute repetition', () => {
  const topics = ['숲길','우주선','발명품','우산','체스','기차','도서관','고양이','연극','바닷가','로봇','신발','여행','괴담','전시회','음악','자전거','편지','날씨','탐정','보물','향수','악기','그림'];
  const messages = topics.map((topic, i) => ({ id: i + 1, from: IDS[i % 4], ts: NOW - (topics.length - i) * 20_000,
    text: `${['아디나','비앙카','일레븐','루치아'][i % 4]} ${topic} 너무 좋아요. 진짜 나도 그렇게 생각해요. ${['다요','소녀','랄까나','그대'][i % 4]}` }));
  assert.equal(repeatedConversation(messages, NOW), false);
  assert.equal(repeatedConversation(messages.map(m => ({ ...m, text: m.text + ' 기대돼요.' })), NOW), false,
    'one recurring word and its prefix cannot count as two recurring subjects');
});

test('one optional conversational cue, no room-wide chorus and no retry/host interference', t => {
  const f = fixture(t), before = structuredClone(f.world.avatars);
  assert.equal(f.flow.hint(f.world, 'gpt', { messages: echo(), now: NOW, hostPending: true }), '');
  assert.equal(f.flow.hint(f.world, 'gpt', { messages: echo(), now: NOW, continuation: true }), '');
  assert.match(f.flow.hint(f.world, 'gpt', { messages: echo(), now: NOW }), /같은 소재.*pass/s);
  for (const actor of IDS) assert.equal(f.flow.hint(f.world, actor, { messages: echo(), now: NOW + M }), '');
  assert.deepEqual(f.world.avatars, before);
  assert.equal(f.save.mock.callCount(), 0);
});

test('long stay offers a reachable walk, changes no avatar, and staggers companions', t => {
  const f = fixture(t), before = structuredClone(f.world.avatars);
  const now = advance(f, 16);
  const text = f.flow.hint(f.world, 'gpt', { now });
  assert.match(text, /한동안 같은 자리/);
  const { move } = JSON.parse(text.match(/\{"move":\[[^\]]+\]\}/)[0]);
  assert.deepEqual(f.world.avatars, before);
  assert.equal(f.save.mock.callCount(), 0);
  assert.equal(f.flow.hint(f.world, 'gemini', { now }), '');
  assert.equal(f.flow.hint(f.world, 'gpt', { now: now + 4 * M }), '', 'declining does not prompt again immediately');
  assert.equal(f.world.move('gpt', move), true, 'the offered movement is actually executable');
  assert.equal(f.world.avatars.gpt.posture, 'stand');
  f.flow.observe(f.world, { active: true, now: now + 1000 });
  assert.equal(f.flow.allowSeatOffer('gpt', now + 1000), false, 'do not immediately herd a walker back to the sofa');
});

test('room-off, sleep, clock jumps and a fresh position do not count as sitting', t => {
  const f = fixture(t);
  const off = advance(f, 60, { active: false });
  f.flow.observe(f.world, { active: true, now: off });
  assert.equal(f.flow.hint(f.world, 'gpt', { now: off }), '');
  f.flow.observe(f.world, { active: true, now: off + 24 * 60 * M });
  assert.equal(f.flow.hint(f.world, 'gpt', { now: off + 24 * 60 * M }), '');
  const now = advance(f, 16, { from: off + 24 * 60 * M });
  f.world.avatars.gpt = { x: 20, y: 4, z: 28, posture: 'stand' };
  f.flow.observe(f.world, { active: true, now: now + 1000 });
  assert.equal(f.flow.hint(f.world, 'gpt', { now: now + 1000 }), '');
});

test('photos, active cooking/games, arrivals and lying down are not interrupted for a walk', t => {
  const f = fixture(t), now = advance(f, 16);
  assert.equal(f.flow.hint(f.world, 'gpt', { now, photoBusy: true }), '');
  assert.equal(f.flow.hint(f.world, 'gpt', { now, living: { meal: { status: 'cooking', cook: 'gpt' } } }), '');
  assert.equal(f.flow.hint(f.world, 'gpt', { now, living: { game: { status: 'playing', players: ['gpt'] } } }), '');
  f.world.avatars.gpt.posture = 'lie';
  assert.equal(f.flow.hint(f.world, 'gpt', { now }), '');
  f.world.avatars.gpt.posture = 'sit';
  const a = f.world.avatars.gpt;
  f.world.movements.set('gpt', { avatar: a, moveId: now, path: [{ x: a.x + 8, y: a.y, z: a.z }, { x: a.x, y: a.y, z: a.z }] });
  assert.equal(f.flow.hint(f.world, 'gpt', { now }), '');
});

test('unreachable spaces issue no fictitious action and rate-limit navigation checks', t => {
  const f = fixture(t), now = advance(f, 16);
  const nav = t.mock.method(f.world, 'navigationPath', () => null);
  assert.equal(f.flow.hint(f.world, 'gpt', { now }), '');
  assert.equal(nav.mock.callCount(), 4);
  assert.equal(f.flow.hint(f.world, 'gpt', { now: now + 1000 }), '');
  assert.equal(nav.mock.callCount(), 4);
});

test('suppressing a return-seat offer still permits a genuine settled group photo', t => {
  const f = fixture(t), hints = new CozyChatHints();
  hints.hint(f.world, 'gpt', { now: NOW, photoAvailable: true, allowSeatOffer: false });
  assert.match(hints.hint(f.world, 'gpt', { now: NOW + M, photoAvailable: true, allowSeatOffer: false }), /사진 한 장/);
});
