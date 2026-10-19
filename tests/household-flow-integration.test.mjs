// Actual server bytes, synthetic persisted state, real fixture loopback HTTP only.
// Provider adapters and every outbound connection remain denied unless a single
// matching chat action has been explicitly queued in serviceFixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HouseholdFlow } from '../lib/household-flow.mjs';
import { buildHouse } from '../lib/house.mjs';
import { serviceFixture, pause } from './helpers/service-fixture.mjs';

const IDS = ['claude', 'gpt', 'deepseek', 'gemini'];
const PUBLIC = { claude: 'eleven', gpt: 'adina', deepseek: 'lucia', gemini: 'bianca' };
const STORY = 'stories/shared-story.md';
const ORIGINAL = '# 함께 쓰는 짧은 이야기\n\n종이배가 중정의 작은 물길에 멈췄다.\n';
const APPEND = '\n바람이 불자 배 안의 꽃잎 하나가 고개를 들었다.\n';

function sleepingSnapshot() {
  const flow = new HouseholdFlow(), now = Date.now();
  for (const id of IDS) assert.equal(flow.start(id, { kind: 'sleep', minutes: 40 }, now), true);
  return flow.snapshot();
}

function client(f, cookie) {
  return {
    post: (route, body) => f.request('/chat' + route, { method: 'POST', origin: f.origin, cookie, body }),
    async get(route) {
      const response = await f.request('/chat' + route, { cookie });
      assert.equal(response.status, 200, route);
      return response.json;
    },
  };
}

async function until(label, read, ready, timeout = 15000) {
  const deadline = performance.now() + timeout;
  let last;
  do {
    last = await read();
    if (ready(last)) return last;
    await pause(100);
  } while (performance.now() < deadline);
  assert.fail(`${label} timed out: ${JSON.stringify(last).slice(-2000)}`);
}

function seedStory(f) {
  const file = path.join(f.home, 'workspace', ...STORY.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ORIGINAL, { flag: 'wx' });
  return file;
}

test('persisted four-person sleep survives room ON; only admin-called Adina appends and works at her desk', { timeout: 52000 }, async t => {
  const savedFlow = sleepingSnapshot();
  const reply = {
    action: 'say', messages: ['한 줄만 이어 써볼게요.'],
    files: [{ op: 'append', path: STORY, content: APPEND }],
    leisure: { kind: 'write', minutes: 6 },
  };
  const f = await serviceFixture(t, {
    messageCount: 2, householdFlow: savedFlow, worldSnapshot: buildHouse(), speed: 'fast',
    scriptedReplies: { gpt: [reply] },
  });
  assert.equal(f.serverHash, createHash('sha256').update(fs.readFileSync(new URL('../server.mjs', import.meta.url))).digest('hex'));
  const file = seedStory(f), beforeBytes = fs.readFileSync(file);
  const readSaved = () => JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'), 'utf8'));
  assert.deepEqual(readSaved().householdFlow, savedFlow);
  const { cookie } = await f.login(), api = client(f, cookie);
  const before = await api.get('/api/admin/raw/state');
  const beforeWorld = await api.get('/api/world');
  assert.equal(before.room.running, false);
  assert.equal(before.room.sleeping, true);
  assert.equal(before.room.speed, 'fast');
  assert.equal(before.members.length, 4);
  assert.ok(before.members.every(member => member.enabled && member.available && member.calls === 0));
  assert.equal(beforeWorld.home.id, 'mulgyeol-maru');

  const on = await api.post('/api/room', { running: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.running, true);
  assert.equal(on.json.sleeping, false);
  // Real fast scheduler: room-open idle deadlines are 4–25 s and the quiet
  // threshold is 20 s. Cross both upper bounds; a short immediate check is weak.
  await pause(27000);
  const asleep = await api.get('/api/admin/raw/state'), quietMetrics = await f.metrics();
  assert.equal(asleep.room.running, true);
  assert.equal(asleep.room.sleeping, false);
  assert.ok(asleep.members.every(member => member.status === 'sleeping' && member.calls === 0));
  assert.equal(asleep.room.calls, before.room.calls);
  assert.deepEqual(readSaved().householdFlow, savedFlow);
  assert.deepEqual(await api.get('/api/world'), beforeWorld);
  assert.deepEqual(fs.readFileSync(file), beforeBytes);
  assert.deepEqual(quietMetrics.scriptedCalls, []);
  assert.deepEqual(quietMetrics.scriptedRemaining, { gpt: 1 });
  assert.deepEqual(quietMetrics.violations, []);

  const sent = await api.post('/api/send', {
    text: `@아디나 ${STORY}의 마지막 문단 뒤에 한 문장만 이어 쓰고 잠깐 글에 집중해 줘.`,
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.ok, true);
  const hostId = sent.json.msg.id;
  const finished = await until('Adina completes the only scripted turn', () => api.get('/api/admin/raw/state'),
    value => value.members.find(member => member.id === 'gpt')?.calls === 1
      && value.members.find(member => member.id === 'gpt')?.status === 'idle');
  await until('write commitment reaches persistence', async () => readSaved(),
    value => value.householdFlow?.residents.gpt.kind === 'write');
  await pause(1500); // Subsequent real ticks must not wake peers or retry the reply.
  const state = await api.get('/api/state'), world = await api.get('/api/world');
  const metrics = await f.metrics(), persisted = readSaved();
  assert.equal(finished.room.calls, before.room.calls + 1);
  assert.equal(state.room.running, true);
  assert.equal(state.room.sleeping, false);
  assert.equal(metrics.guardInstalled, true);
  assert.deepEqual(metrics.violations, []);
  assert.equal(metrics.scriptedCalls.length, 1);
  assert.deepEqual(metrics.scriptedRemaining, { gpt: 0 });
  assert.equal(metrics.scriptedCalls[0].id, 'gpt');
  assert.ok(metrics.scriptedCalls[0].turn.includes(ORIGINAL), 'the actual turn contains the existing file preview');
  assert.match(metrics.scriptedCalls[0].turn, /@아디나/);
  assert.equal(metrics.scriptedCalls[0].opts.boost, false);
  assert.deepEqual(metrics.scriptedCalls[0].opts.images, []);

  const finalBytes = fs.readFileSync(file);
  assert.deepEqual(finalBytes.subarray(0, beforeBytes.length), beforeBytes, 'all prior paragraphs preserved byte for byte');
  assert.equal(finalBytes.toString('utf8'), ORIGINAL + APPEND, 'one exact append, without retry or overwrite');
  assert.equal((await api.get(`/api/admin/raw/file?path=${encodeURIComponent(STORY)}`)).text, ORIGINAL + APPEND);
  const publicFile = state.files.find(entry => entry.path === STORY);
  assert.ok(publicFile, 'the actual workspace list publishes the updated story');
  assert.equal((await api.get(`/api/file?path=${encodeURIComponent(publicFile.path)}`)).text, ORIGINAL + APPEND);
  assert.deepEqual(world.blocks, beforeWorld.blocks);
  assert.deepEqual(world.home, beforeWorld.home);
  assert.equal(world.avatars.adina.posture, 'work');
  assert.deepEqual(world.avatars.adina.furniture.at, beforeWorld.home.furniture['adina-desk'].at);
  assert.notDeepEqual(world.avatars.adina, beforeWorld.avatars.adina);
  assert.equal(persisted.householdFlow.residents.gpt.kind, 'write');
  assert.equal(persisted.householdFlow.residents.gpt.recent.at(-1).kind, 'write');
  for (const id of IDS.filter(id => id !== 'gpt')) {
    assert.deepEqual(persisted.householdFlow.residents[id], savedFlow.residents[id]);
    assert.deepEqual(world.avatars[PUBLIC[id]], beforeWorld.avatars[PUBLIC[id]]);
    assert.equal(state.members.find(member => member.id === PUBLIC[id]).status, 'sleeping');
    assert.equal(finished.members.find(member => member.id === id).calls, 0);
  }
  const generated = state.messages.filter(message => message.id > hostId);
  assert.equal(generated.filter(message => message.from === 'adina' && message.text).length, 1);
  assert.equal(generated.filter(message => message.kind === 'file').length, 1);
  assert.ok(!generated.some(message => ['eleven', 'lucia', 'bianca'].includes(message.from)));
  const stopped = await f.shutdown();
  assert.equal(stopped.code, 0);
  assert.equal(stopped.signal, null);
  const diskWorld = JSON.parse(fs.readFileSync(path.join(f.data, 'world.json'), 'utf8'));
  assert.equal(diskWorld.avatars.gpt.posture, 'work');
  assert.deepEqual(diskWorld.avatars.gpt.furniture.at, beforeWorld.home.furniture['adina-desk'].at);
  assert.equal(readSaved().room.calls, before.room.calls + 1);
  t.diagnostic('27 s room-ON silence; exactly one scripted chat; original story + one append; Adina at her desk; three unchanged sleeping peers; zero provider/egress violations.');
});

test('mixed leisure + image is rejected before speech, append, notes, movement or image provider access', { timeout: 22000 }, async t => {
  const savedFlow = sleepingSnapshot();
  const blockedText = '혼합 요청의 말풍선은 게시되면 안 된다.';
  const f = await serviceFixture(t, {
    messageCount: 2, householdFlow: savedFlow, worldSnapshot: buildHouse(), speed: 'fast', imageGen: true,
    scriptedReplies: { gpt: [{
      action: 'say', messages: [blockedText],
      leisure: { kind: 'write', minutes: 6 },
      image: 'A small blue paper boat on a plain table.',
      files: [{ op: 'append', path: STORY, content: APPEND }],
      note_add: '혼합 요청으로 저장되면 안 되는 메모.',
    }] },
  });
  const file = seedStory(f), beforeBytes = fs.readFileSync(file);
  const { cookie } = await f.login(), api = client(f, cookie);
  const before = await api.get('/api/admin/raw/state');
  const beforeWorld = await api.get('/api/world'), beforeNotes = await api.get('/api/notes');
  assert.equal(before.members.find(member => member.id === 'gpt').imageGen, true,
    'this boundary must exercise enabled image generation, not a disabled feature');
  const on = await api.post('/api/room', { running: true });
  assert.equal(on.status, 200);
  const sent = await api.post('/api/send', { text: '@아디나, 합성 혼합 요청 경계를 확인해 줘.' });
  assert.equal(sent.status, 200);
  const hostId = sent.json.msg.id;
  const state = await until('mixed-action rejection appears on the actual HTTP API', () => api.get('/api/state'),
    value => value.members.find(member => member.id === 'adina')?.status === 'idle'
      && value.messages.some(message => message.id > hostId && message.from === 'system'
        && message.kind === 'info' && /자유시간 요청.*따로 선택/.test(message.text)));
  await pause(1200); // Include delayed writes and any accidental async image dispatch.
  const metrics = await f.metrics(), after = await api.get('/api/admin/raw/state');
  assert.equal(metrics.guardInstalled, true);
  assert.deepEqual(metrics.violations, [], 'provider:image remains a hard denial if ever reached');
  assert.deepEqual(metrics.scriptedCalls.map(call => call.id), ['gpt']);
  assert.deepEqual(metrics.scriptedRemaining, { gpt: 0 });
  assert.equal(after.room.calls, before.room.calls + 1);
  assert.ok(after.members.every(member => member.calls === (member.id === 'gpt' ? 1 : 0)));
  assert.deepEqual(fs.readFileSync(file), beforeBytes);
  assert.deepEqual(await api.get('/api/world'), beforeWorld);
  assert.deepEqual(await api.get('/api/notes'), beforeNotes);
  const generated = (await api.get('/api/state')).messages.filter(message => message.id > hostId);
  assert.equal(generated.filter(message => message.kind === 'info' && /자유시간 요청/.test(message.text)).length, 1);
  assert.ok(!generated.some(message => message.from === 'adina' || message.kind === 'file' || message.kind === 'drawing'));
  assert.ok(!generated.some(message => message.text === blockedText));
  assert.ok(!state.files.some(entry => entry.path.startsWith('images/')));
  const persisted = JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'), 'utf8'));
  assert.equal(persisted.householdFlow.residents.gpt.kind, null, 'host wake occurs, but rejected leisure never starts');
  for (const id of IDS.filter(id => id !== 'gpt')) {
    assert.deepEqual(persisted.householdFlow.residents[id], savedFlow.residents[id]);
    assert.equal(after.members.find(member => member.id === id).status, 'sleeping');
  }
  const stopped = await f.shutdown();
  assert.equal(stopped.code, 0);
  assert.equal(stopped.signal, null);
  t.diagnostic('With image generation enabled, mixed leisure+image yields only the rejection notice; no file, note, speech, world or image-provider side effects.');
});
