import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as i18n from '../lib/i18n.mjs';
import * as members from '../lib/members.mjs';
import * as prompts from '../lib/prompt.mjs';
import koPrompts from '../lib/prompts/ko.mjs';
import enPrompts from '../lib/prompts/en.mjs';
import jaPrompts from '../lib/prompts/ja.mjs';
import { personaFor, personaTurnCue } from '../lib/personas.mjs';
import { Store } from '../lib/store.mjs';
import { loadImageAliases } from '../lib/image-aliases.mjs';
import { World } from '../lib/world.mjs';
import { PlanBook, PlanError, DEFAULT_PLANNER_CFG } from '../lib/plans.mjs';
import { claudeStructuredReply } from '../lib/agents.mjs';
import { formatMemberSpeech, takeParticipationTurn } from '../lib/member-speech.mjs';
import * as conversationEfficiency from '../lib/conversation-efficiency.mjs';
import { LivingRoom } from '../lib/living.mjs';
import { buildHouse } from '../lib/house.mjs';
import * as livingIntegration from '../lib/living-integration.mjs';
import { AdminAuth } from '../lib/admin-auth.mjs';
import { publicRoom, publicMember, publicMessage, publicPlans, batteryView, sleepStates, publicEvent } from '../lib/public-view.mjs';
import * as httpLimits from '../lib/http-limits.mjs';
import { TopicStore, TopicError } from '../lib/topics.mjs';
import { EventEmitter } from 'node:events';
import { createPublicIdentity, internalMemberId, resolveCharacterAsset } from '../lib/public-identity.mjs';
import { createPublicWorkspace, readPublicPng, PUBLIC_IMAGE_NOTICE } from '../lib/public-files.mjs';
import http from 'node:http';
import { tinyPng, pngChunk } from './privacy-fixtures.mjs';
import { Readable } from 'node:stream';
import { saveImageFile } from '../lib/image-files.mjs';
import * as worldActions from '../lib/world-actions.mjs';
import { ImagePreviews } from '../lib/image-preview.mjs';
import { LiarGame } from '../lib/liar-game.mjs';
import { LiarSession } from '../lib/liar-session.mjs';
import { buildLiarTurn } from '../lib/liar-turn.mjs';
import { deliverTopicMail } from '../lib/topic-mail.mjs';
import { proxyAccess } from '../lib/proxy-access.mjs';
import { publicId } from '../lib/public-identity.mjs';
import * as photocards from '../lib/photocards.mjs';
import * as cozyChat from '../lib/cozy-chat.mjs';
import { PhotoMoments } from '../lib/photo-moments.mjs';
import { RoomRhythm } from '../lib/room-rhythm.mjs';
import * as householdFlow from '../lib/household-flow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests');
const SOURCE = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const request = { title: '달빛 정자', brief: 'A small shaded pavilion for tea', site: [0, 0, 13, 13] };
const recipe = {
  kind: 'house', origin: [2, 2], size: [7, 7], wallHeight: 3, front: 'n',
  materials: { foundation: 'stone', wall: 'white', trim: 'log', floor: 'planks', roof: 'black', window: 'glass', accent: 'purple' },
  roof: { type: 'gable', ridge: 'x', overhang: 1 },
  windows: { spacing: 3, height: 1, sill: 1 }, features: [],
};
const definition = { name: 'test_tile', pixels: Array(8).fill('aaaaaaaa'), colors: { a: '#123456' } };
const fill = (count, block = 'stone') => [{ op: 'fill', from: [20, 1, 20], to: [20 + count - 1, 1, 20], block }];
const pacing = h => h.SPEEDS[h.room.speed] || h.SPEEDS.normal;
// Only the compact reader adds a 15-second floor; Gemini uses the preset directly.
const batchRead = (h, id = 'gemini') => pacing(h).read.map(seconds => id === 'claude' ? Math.max(15, seconds) : seconds);
function assertDelay(wakeAt, now, [lo, hi]) {
  assert.ok(Number.isFinite(wakeAt), 'a reply must have a finite deadline');
  assert.ok(wakeAt >= now + lo * 1000 && wakeAt <= now + hi * 1000,
    `scheduled delay ${wakeAt - now}ms must follow ${lo}–${hi}s`);
}

// Evaluate the real server with fake transport, adapters and clocks. Nothing binds a
// socket or polls a provider; real Store, World and PlanBook operate only in CHATROOM_HOME.
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(FIXTURES, '.planner-fixture-'));
  const configFile = path.join(home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ language: 'ko', port: 0, host: '127.0.0.1',
    constructionEnabled: true, imageGen: false, external: { enabled: false }, dev: { enabled: false },
    spark: { enabled: false }, ...options.config }));
  if (options.house) {
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data', 'world.json'), JSON.stringify(buildHouse()));
  }
  if (options.room) {
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data/state.json'), JSON.stringify({ room: options.room }));
  }
  if (options.liarStartAt) {
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data/liar-game.json'), JSON.stringify({
      version: 1, revision: 0, nextStartAt: options.liarStartAt, announcedFor: null, recentWordIds: [], round: null,
    }));
  }
  const timers = new Map(), events = [], chats = [], calls = [];
  let timerId = 0, listens = 0, server;
  const transport = {
    createServer(handler) {
      server = { handler, on() { return this; }, listen(port) { assert.equal(port, 0); listens++; } };
      return server;
    },
  };
  class FakeAdapters {
    constructor(root, cfg) { assert.equal(root, home); this.cfg = cfg; this.bins = {}; }
    available() { return Object.fromEntries(members.AI_IDS.map((id) => [id, true])); }
    canSee() { return false; }
    maxPromptChars() { return options.maxPromptChars ?? 100000; }
    async chat(id, brief, turn, opts) {
      chats.push({ id, brief, turn, opts });
      if (options.chat) return options.chat(id, brief, turn, opts);
      return { ok: true, text: JSON.stringify(options.action ?? { action: 'pass' }), ms: 1 };
    }
    async plan(prompt) {
      calls.push({ prompt, roomCalls: h.room.calls, gptTimes: [...h.agents.gpt.callTimes] });
      return options.planner ? options.planner(prompt, h) : { ok: true, text: JSON.stringify(recipe), ms: 1 };
    }
  }
  class FakeUsage { view() { return {}; } pollAll() {} }
  class FakeDev { online = false; notify() {} close() {} }
  class FakeRouter {
    static parseCommand() { return null; }
    constructor(cfg) { this.cfg = cfg; }
    boostOf(id) { return this.cfg.agents[id]?.boost; }
    decide() { return null; }
  }
  const noExternal = class { constructor() { throw new Error('External access is forbidden in fixtures'); } };
  class FixtureImagePreviews extends ImagePreviews {
    constructor(directory) { super(directory, { render: async () => { throw new Error('No image subprocesses in server fixtures'); } }); }
  }
  const context = vm.createContext({
    ...i18n, ...members, ...prompts, ...worldActions, ...conversationEfficiency, ...livingIntegration, LivingRoom, fs, path, fileURLToPath, URL, Buffer, Date, structuredClone,
    Store, loadImageAliases, World, PlanBook, PlanError, DEFAULT_PLANNER_CFG, personaFor, formatMemberSpeech, takeParticipationTurn, koPrompts, enPrompts, jaPrompts,
    AdminAuth, publicRoom, publicMember, publicMessage, publicPlans, batteryView, sleepStates, publicEvent,
    ...httpLimits, TopicStore, TopicError,
    createPublicIdentity, internalMemberId, resolveCharacterAsset, createPublicWorkspace, readPublicPng, PUBLIC_IMAGE_NOTICE,
    saveImageFile, ImagePreviews: FixtureImagePreviews, LiarGame, LiarSession, buildLiarTurn,
    deliverTopicMail, proxyAccess, publicId, ...photocards, ...cozyChat, PhotoMoments, RoomRhythm, ...householdFlow,
    Adapters: FakeAdapters, UsageMonitor: FakeUsage, DevBridge: FakeDev, Router: FakeRouter,
    devChainState: options.devChainState || (() => null), ExternalGate: noExternal,
    http: transport, https: transport,
    spawn() { throw new Error('No subprocesses in server fixtures'); }, killAll() {}, runningChildren: new Set(),
    shootWorld() { throw new Error('No browser screenshots in server fixtures'); },
    process: { env: { CHATROOM_HOME: home, CHATROOM_CONFIG: configFile, PORT: '0' }, argv: [],
      platform: process.platform, on() {}, exit() { throw new Error('Unexpected server exit'); } },
    console: { log() {}, error() {} },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {},
  });
  // Imports are supplied explicitly above. Production server code is otherwise unchanged.
  const source = SOURCE.replace(/^import .*;\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(ROOT, 'server.mjs')).href));
  new vm.Script(source + '\nglobalThis.harness = { cfg, room, agents, store, world, living, plans, ask, runTurn, perform, performWorldAction, handleApi, handleRequest, clients, eventHub, clientAuth, broadcast, refreshClientSession, admin, planNotice, tick, continuePlan, processPlanQueue, stopRoom, startRoom, spark, maybeSpark, sparkDone, SPEEDS, imageAliases };',
    { filename: path.join(ROOT, 'server.mjs') }).runInContext(context);
  const h = context.harness;
  // Legacy fake responses now model the lifecycle used by bounded HTTP/SSE.
  const realHandleRequest = h.handleRequest;
  h.handleRequest = (req, res) => {
    req.socket ??= { remoteAddress: '127.0.0.1' };
    if (!res.once) {
      const emitter = new EventEmitter(); res.once = emitter.once.bind(emitter);
      const end = res.end; res.end = function (...args) { const result = end.apply(this, args); emitter.emit('finish'); return result; };
      res.setHeader ??= () => {};
    }
    return realHandleRequest(req, res);
  };
  h.clients.add = res => {
    const emitter = new EventEmitter(); res.once ??= emitter.once.bind(emitter);
    res.destroy ??= () => emitter.emit('close');
    const write = res.write; res.write = frame => { write(frame); return true; };
    return h.eventHub.add(new EventEmitter(), res, 'fixture');
  };
  h.world.save = () => {}; // legacy debounce is irrelevant; applyCells keeps its durable writes
  h.clients.add({ write(value) {
    const match = /^event: (.+)\ndata: (.+)\n\n$/.exec(value);
    if (match) events.push({ type: match[1], data: JSON.parse(match[2]) });
  } });
  if (!options.room) { h.room.running = true; h.living?.resume(); }
  assert.equal(listens, 1);
  t.after(() => {
    clearTimeout(h.world.saveTimer);
    timers.clear();
    const resolved = path.resolve(home);
    assert.equal(path.dirname(resolved), FIXTURES);
    assert.ok(path.basename(resolved).startsWith('.planner-fixture-'));
    fs.rmSync(resolved, { recursive: true, force: true });
    i18n.setLang('ko');
  });
  return Object.assign(h, { home, events, calls, chats, timers, server,
    async action(act, id = 'claude') { return h.performWorldAction(h.agents[id], act); },
    async request(id = 'claude', value = request) {
      await h.performWorldAction(h.agents[id], { plan_request: value });
      return h.plans.view().plans.at(-1);
    },
    async api(method, pathname, input, headers = {}) {
      let status, body; const responseHeaders = {};
      const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]);
      req.method = method;
      req.headers = { host: 'localhost:0', ...headers };
      Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1', encrypted: false } });
      await h.handleApi(req, {
        setHeader(k,v) { responseHeaders[k] = v; },
        writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); },
      }, new URL(pathname, 'http://fixture.invalid'));
      return { status, body, headers: responseHeaders };
    },
  });
}

test('structured SVG file operations persist before show, and malformed containers are visible errors', async (t) => {
  const h = fixture(t);
  const content = '<svg xmlns="http://www.w3.org/2000/svg"><text>장미 \\n</text></svg>';
  const files = [{ op: 'write', path: 'images/parasol_bianca.svg', content }];
  const raw = claudeStructuredReply({ type: 'result', subtype: 'success', is_error: false,
    structured_output: { action: 'pass', files: JSON.stringify(files), show: files[0].path } });
  await h.perform(h.agents.claude, prompts.parseAction(raw), h.store.lastId, 'urgent');
  assert.equal(h.store.readFile(files[0].path).text, content);
  assert.equal(h.store.meta[files[0].path].by, 'claude');
  assert.equal(h.store.recent(1)[0].attach.path, files[0].path);
  assert.equal(h.store.messages.some(m => m.kind === 'error'), false);
  const marker = h.store.lastId;
  await h.perform(h.agents.claude, { action: 'pass', files: '{}', show: 'missing.svg' }, marker, 'urgent');
  const errors = h.store.after(marker);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'error');
  assert.match(errors[0].text, /files.*배열/);
  assert.equal(fs.existsSync(h.store.abs('missing.svg')), false);
});

test('Eleven surface formatting changes chat only while file content and actions stay intact', async (t) => {
  const h = fixture(t);
  const action = {action:'say',messages:['앗 건축하라네 랄까나! ㅋㅋ'],
    files:[{op:'write',path:'literal.txt',content:'ㅋㅋ 신기한데 랄까나'}],note_add:'ㅋㅋ 기억 원문'};
  const before=structuredClone(action);
  const pending=h.perform(h.agents.claude,action,h.store.lastId,'urgent');
  [...h.timers.values()].find(v=>v.ms>500).fn();
  await pending;
  assert.equal(h.store.messages.find(m=>m.from==='claude').text,'앗 건축하라네!');
  assert.equal(h.store.readFile('literal.txt').text,action.files[0].content);
  assert.match(h.store.readNote('claude'),/ㅋㅋ 기억 원문/);
  assert.deepEqual(action,before);
});

test('half background participation consumes skipped notifications once and preserves host replies', async (t) => {
  let now=Date.now(); t.mock.method(Date,'now',()=>now);
  const h=fixture(t); h.room.autoSleepMin=0; h.cfg.agents.claude.participation=0.5;
  for(const id of members.AI_IDS) h.room.enabled[id]=id==='claude';
  const a=h.agents.claude;
  const prime=()=>{a.wakeAt=now-1;a.reason='urgent';a.lastEnd=now-60000;};
  h.store.addMessage({from:'gemini',text:'@일레븐 이 색은 어떠냐?'});prime();h.tick();
  assert.equal(a.seen,h.store.lastId);assert.equal(h.chats.length,0);
  for(let i=0;i<10;i++){now+=500;h.tick();}
  assert.equal(h.chats.length,0,'same notification cannot become a new opportunity');
  h.store.addMessage({from:'gemini',text:'@일레븐 나는 노란색이 좋구나.'});prime();h.tick();
  for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(h.chats.length,1);
  assert.equal(a.busy,false);
  const credit=a.participationCredit;
  h.store.addMessage({from:'user',text:'@일레븐 네 생각은 어때?'});prime();h.tick();
  for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(h.chats.length,2);
  assert.equal(a.participationCredit,credit);
});

test('efficient Eleven coalesces peer bursts in the real scheduler and preserves direct host turns', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = fixture(t, { config: { constructionEnabled: false, agents: { claude: { chatEfficiency: true, participation: .4 } } } });
  h.room.autoSleepMin = 0;
  for (const id of members.AI_IDS) h.room.enabled[id] = id === 'claude';
  const a = h.agents.claude;
  a.seen = h.store.lastId; a.lastEnd = now - 60000; a.participationCredit = .8;
  const first = h.store.addMessage({ from: 'gemini', text: '@일레븐 차 한잔하겠느냐?' });
  h.tick();
  assertDelay(a.wakeAt, now, batchRead(h, a.id));
  now += 8000;
  const second = h.store.addMessage({ from: 'deepseek', text: '소녀는 찻잔을 골랐답니다.' });
  h.tick();
  assert.equal(h.chats.length, 0);
  assertDelay(a.wakeAt, now, batchRead(h, a.id));
  const peerDeadline = a.wakeAt;
  now = Math.ceil(peerDeadline) - 1; h.tick();
  assert.equal(h.chats.length, 0, 'coalesced peers must not trigger an early call');
  now += 1; h.tick();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.chats.length, 1);
  assert.ok(h.chats[0].turn.includes(`#${first.id}`));
  assert.ok(h.chats[0].turn.includes(`#${second.id}`));
  assert.equal(a.busy, false);
  now += 60000;
  h.store.addMessage({ from: 'user', text: '@일레븐 너는 무슨 차가 좋아?' });
  const credit = a.participationCredit;
  h.tick(); const hostDeadline = a.wakeAt;
  assertDelay(hostDeadline, now, pacing(h).hostRead);
  now += 1000;
  h.store.addMessage({ from: 'gemini', text: '나는 노란 찻잔이다.' }); h.tick();
  assert.equal(a.wakeAt, hostDeadline);
  now = hostDeadline; h.tick();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.chats.length, 2);
  assert.equal(a.participationCredit, credit);
});

test('living actions use real home furniture, food and a visible legal board without extra model calls', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = fixture(t, { house: true, config: { constructionEnabled: false } });
  h.room.autoSleepMin = 0;
  for (const id of members.AI_IDS) h.room.enabled[id] = false;
  const action = (id, command) => h.performWorldAction(h.agents[id], { living: command });
  assert.equal(await action('claude', { op: 'cook', recipe: 'soup' }), true);
  assert.equal(h.world.avatars.claude.furniture.shape, 'workbench');
  let meal = h.living.view().meal;
  now = meal.readyAt + 1; h.tick();
  meal = h.living.view().meal;
  assert.equal(meal.status, 'ready');
  assert.equal(await action('claude', { op: 'serve', mealId: meal.id, revision: meal.revision }), true);
  for (const id of members.AI_IDS) {
    meal = h.living.view().meal;
    assert.equal(await action(id, { op: 'eat', mealId: meal.id, revision: meal.revision }), true, id);
    assert.equal(h.world.avatars[id].furniture.shape, 'chair');
  }
  assert.equal(h.living.view().meal.remaining, 0);
  assert.equal(await action('claude', { op: 'game_create' }), true);
  let game = h.living.view().game;
  assert.equal(await action('gemini', { op: 'game_join', gameId: game.id, revision: game.revision }), true);
  for (const [id, cell] of [['claude',0],['gemini',3],['claude',1],['gemini',4],['claude',2]]) {
    game = h.living.view().game;
    assert.equal(await action(id, { op: 'game_move', gameId: game.id, revision: game.revision, cell }), true);
  }
  assert.equal(h.living.view().game.winner, 'claude');
  assert.equal(h.chats.length, 0);
  const event = h.events.filter(e => e.type === 'living').at(-1);
  assert.equal(event.data.game.winner, 'eleven');
  assert.deepEqual(event.data.game.players, ['eleven','bianca']);
  assert.doesNotMatch(JSON.stringify(event.data), /claude|gemini|deepseek|gpt/);
});

test('stale or conflicting living commands and stopped-room actions cannot move avatars or change a board', async t => {
  const h = fixture(t, { house: true, config: { constructionEnabled: false } });
  await h.performWorldAction(h.agents.claude, { living: { op: 'game_create' } });
  const game = h.living.view().game;
  const before = JSON.stringify({ living: h.living.view(), avatars: h.world.avatarView() });
  assert.equal(await h.performWorldAction(h.agents.gemini, { living: { op: 'game_join', gameId: game.id, revision: -1 } }), false);
  assert.equal(await h.performWorldAction(h.agents.gemini, { living: { op: 'game_join', gameId: game.id, revision: game.revision }, move: [15,33] }), false);
  h.room.running = false;
  assert.equal(await h.performWorldAction(h.agents.gemini, { living: { op: 'game_join', gameId: game.id, revision: game.revision } }), false);
  assert.equal(JSON.stringify({ living: h.living.view(), avatars: h.world.avatarView() }), before);
});

test('a living persistence failure restores real avatar movement and publishes no success', async t => {
  const h = fixture(t, { house: true, config: { constructionEnabled: false } });
  const before = JSON.stringify({ state: h.living.view(), avatars: h.world.avatarView(), movements: [...h.world.movements], sequence: h.world.moveSequence });
  const original = h.living.act.bind(h.living);
  t.mock.method(h.living, 'act', (actor, command, at, options) => {
    if (options?.dryRun) return original(actor, command, at, options);
    throw new Error('synthetic persistence failure');
  });
  const eventCount = h.events.length;
  assert.equal(await h.performWorldAction(h.agents.claude, { living: { op: 'cook', recipe: 'tea' } }), false);
  assert.equal(JSON.stringify({ state: h.living.view(), avatars: h.world.avatarView(), movements: [...h.world.movements], sequence: h.world.moveSequence }), before);
  assert.equal(h.events.slice(eventCount).some(e => e.type === 'living' || e.type === 'avatars'), false);
  assert.equal(h.store.messages.at(-1).kind, 'error');
  assert.equal(h.chats.length, 0);
});

test('concurrent stale meal requests remain rejected but display a state-change notice instead of a connection error', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = fixture(t, { house: true, config: { constructionEnabled: false } });
  await h.performWorldAction(h.agents.gpt, { living: { op: 'cook', recipe: 'tea' } });
  now = h.living.view().meal.readyAt; h.living.advance(now);
  const meal = h.living.view().meal, command = { op: 'serve', mealId: meal.id, revision: meal.revision };
  assert.equal(await h.performWorldAction(h.agents.gpt, { living: command }), true);
  const state = JSON.stringify(h.living.view());
  assert.equal(await h.performWorldAction(h.agents.deepseek, { living: command }), false);
  assert.equal(JSON.stringify(h.living.view()), state);
  const notice = h.events.filter(e => e.type === 'message').at(-1)?.data ?? h.store.messages.at(-1);
  assert.equal(notice.kind, 'info');
  assert.match(notice.text, /생활 상태가 먼저 변경/);
  assert.doesNotMatch(notice.text, /관리자|연결|revision|gpt|deepseek/);
  assert.equal(h.chats.length, 0);
});

test('all model reply paths accept standalone living JSON and unused optional fields without extra calls', async t => {
  for (const id of members.AI_IDS) {
    const h = fixture(t, { house: true, config: { constructionEnabled: false },
      action: { living: { op: 'cook', recipe: 'tea', cell: null, gameId: null, revision: null } } });
    h.agents[id].reason = 'idle';
    await h.runTurn(h.agents[id]);
    assert.equal(h.chats.length, 1, id);
    assert.equal(h.living.view().meal?.cook, id);
    assert.equal(h.living.view().meal?.status, 'cooking');
    assert.equal(h.world.avatars[id].furniture.shape, 'workbench');
  }
});

test('all four may request persisted drafts; one real planner call is accounted immediately and duplicates do not call', async (t) => {
  for (const id of members.AI_IDS) {
    const h = fixture(t);
    const plan = await h.request(id);
    assert.equal(plan.status, 'draft');
    assert.equal(plan.completedStages, 0);
    assert.equal(plan.nextStage, 1);
    assert.equal(plan.stages.length, 4);
    assert.equal(h.world.blocks.size, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].roomCalls, 1);
    assert.equal(h.calls[0].gptTimes.length, 1);
    assert.equal(h.agents[id].status, 'reading');
    assert.equal(h.chats.length, 0);
    assert.equal(h.store.state.room.calls, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'data/state.json'))).room.calls, 1);
    const notice = h.store.messages.at(-1).text;
    assert.match(notice, /아직 짓지 않았어.*0\/4/);
    assert.ok(!notice.includes(plan.id));
    assert.doesNotMatch(notice, /draft|building|Foundation|gpt-|xhigh/);
    await h.request('gemini');
    assert.equal(h.calls.length, 1);
    assert.equal(h.room.calls, 1);
    assert.equal(h.plans.view().plans.length, 1);
    assert.ok(fs.existsSync(path.join(h.home, 'data/world-plans.json')));
  }
});

test('design and raw/stage/cancel mixtures reject the entire world portion, retaining chatter', async (t) => {
  const h = fixture(t);
  const variants = [
    { plan_request: request, build_plan: { id: 'x', stage: 1 } },
    { plan_request: request, plan_cancel: { id: 'x' } },
    { build_plan: { id: 'x', stage: 1 }, plan_cancel: { id: 'x' } },
    ...['plan_request', 'build_plan', 'plan_cancel'].flatMap((key) => [
      { [key]: {}, build: fill(1) }, { [key]: {}, block_define: definition },
    ]),
    { plan_request: null, build: fill(1) },
  ];
  const before = JSON.stringify(h.world.view());
  for (const act of variants) await h.action({ ...act, move: [20, 20] });
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.stringify(h.world.view()), before);
  const pending = h.perform(h.agents.claude, { ...variants[0], action: 'say', messages: ['I prefer a garden.'] }, h.store.lastId, 'urgent');
  const timer = [...h.timers.values()].find((v) => v.ms > 500);
  assert.ok(timer); timer.fn();
  await pending;
  assert.ok(h.store.messages.some((m) => m.text === 'I prefer a garden.'));
  assert.equal(h.calls.length, 0);
});

test('stopping while typing suppresses all world actions and planner calls', async (t) => {
  const h = fixture(t);
  for (const action of [{ plan_request: request }, { build: fill(2), block_define: definition, move: [30, 30] }, { build_plan: { id: 'none', stage: 1 } }]) {
    h.room.running = true;
    const before = JSON.stringify(h.world.view());
    const pending = h.perform(h.agents.claude, { action: 'say', messages: ['Wait a moment'], ...action }, h.store.lastId, 'urgent');
    h.room.running = false;
    const [key, timer] = [...h.timers].find(([, v]) => v.ms > 500);
    h.timers.delete(key); timer.fn();
    await pending;
    assert.equal(JSON.stringify(h.world.view()), before);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.room.calls, 0);
});

test('a room stopped during the planner call keeps a successful draft and never moves or builds', async (t) => {
  let resolve;
  const h = fixture(t, { planner: () => new Promise((r) => { resolve = r; }) });
  h.agents.claude.status = 'typing';
  const before = JSON.stringify(h.world.view());
  const pending = h.action({ plan_request: request, move: [30, 30] });
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.equal(h.room.calls, 1);
  assert.equal(h.agents.claude.status, 'reading');
  h.room.running = false;
  resolve({ ok: true, text: JSON.stringify(recipe), ms: 1 });
  await pending;
  assert.equal(JSON.stringify(h.world.view()), before);
  assert.equal(h.plans.view().plans[0].status, 'draft');
  assert.equal(h.plans.view().plans[0].stages.length, 4);
  assert.equal(h.chats.length, 0);
});

test('a duplicate pending request reports design in progress without claiming a ready 0/0 plan', async (t) => {
  let resolve;
  const h = fixture(t, { planner: () => new Promise((r) => { resolve = r; }) });
  const pending = h.action({ plan_request: request });
  await Promise.resolve();
  await h.action({ plan_request: request }, 'gpt');
  const plan = h.plans.view().plans[0];
  assert.equal(plan.preparing, true);
  for (const lang of ['ko', 'en', 'ja']) {
    i18n.setLang(lang);
    const text = h.planNotice(plan);
    assert.doesNotMatch(text, /0\/0|준비 완료|ready|準備完了/);
    assert.ok(!text.includes(plan.id));
  }
  i18n.setLang('ko');
  assert.match(h.store.messages.at(-1).text, /설계 중/);
  assert.equal(h.calls.length, 1);
  resolve({ ok: true, text: JSON.stringify(recipe), ms: 1 });
  await pending;
  assert.match(h.store.messages.at(-1).text, /아직 짓지 않았어/);
});

test('failed and malformed planner replies consume one call, with no retry or public adapter error', async (t) => {
  for (const result of [{ ok: false, text: '', detail: 'gpt-6-astra xhigh SECRET-provider-error', ms: 1 }, { ok: true, text: '{"broken":', ms: 1 }]) {
    const h = fixture(t, { planner: () => result });
    await h.request();
    assert.equal(h.calls.length, 1);
    assert.equal(h.room.calls, 1);
    assert.equal(h.agents.gpt.callTimes.length, 1);
    assert.equal(h.plans.view().plans[0].status, 'failed');
    assert.equal(h.world.blocks.size, 0);
    assert.doesNotMatch(h.store.messages.at(-1).text, /SECRET|gpt-|xhigh|SyntaxError/);
    assert.equal(h.chats.length, 0);
  }
});

test('invalid/occupied requests make no real call; stopping before dispatch makes no changes', async (t) => {
  const h = fixture(t);
  await h.action({ plan_request: { ...request, site: [0, 0, 20, 20] } });
  h.world.apply(fill(1), 'claude');
  await h.action({ plan_request: { ...request, site: [20, 20, 33, 33] } });
  h.room.running = false;
  const before = JSON.stringify(h.world.view());
  await h.action({ plan_request: request });
  await h.action({ build: fill(2), block_define: definition, move: [30, 30] });
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.stringify(h.world.view()), before);
});

test('voluntary cooperative chunks honor per-plan cooldown and broadcast geometry/avatars before progress', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const h = fixture(t);
  const plan = await h.request('claude');
  h.events.length = 0;
  await h.action({ build_plan: { id: plan.id, stage: 1 } }, 'gpt');
  assert.ok(h.world.blocks.size > 0);
  assert.equal(h.plans.view().plans[0].completedStages, 1);
  const order = h.events.map((e) => e.type);
  assert.ok(order.indexOf('world') < order.indexOf('avatars'));
  assert.ok(order.indexOf('avatars') < order.indexOf('msg'));
  assert.match(h.store.messages.at(-1).text, /1\/4.*기초·바닥/);
  assert.doesNotMatch(h.store.messages.at(-1).text, /Foundation|building/);
  const first = JSON.stringify(h.world.view());
  await h.action({ build_plan: { id: plan.id, stage: 2 } }, 'deepseek');
  assert.equal(JSON.stringify(h.world.view()), first);
  for (const stage of [2, 3, 4]) {
    let chunks = 0;
    do {
      assert.ok(++chunks <= 8);
      now += 25000;
      await h.action({ build_plan: { id: plan.id, stage: 'next' } }, stage === 2 ? 'deepseek' : 'gemini');
    } while (h.plans.view().plans[0].completedStages < stage);
    assert.equal(h.plans.view().plans[0].completedStages, stage);
  }
  assert.equal(h.plans.view().plans[0].status, 'complete');
  assert.match(h.store.messages.at(-1).text, /건축 완료.*4\/4.*현관·장식/);
  const done = JSON.stringify(h.world.view());
  await h.action({ build_plan: { id: plan.id, stage: 4 } });
  assert.equal(JSON.stringify(h.world.view()), done);
  assert.equal(h.calls.length, 1);
});

test('invalid stages, outsider cancellation and changed reserved air cannot alter a plan stage', async (t) => {
  const h = fixture(t);
  const plan = await h.request();
  for (const stage of [0, 1.5, '1', 3]) await h.action({ build_plan: { id: plan.id, stage } }, 'gpt');
  assert.equal(h.world.blocks.size, 0);
  await h.action({ plan_cancel: { id: plan.id } }, 'gpt');
  assert.equal(h.plans.view().plans[0].status, 'draft');
  h.world.blocks.set('12,20,12', 'stone'); // external edit in reserved air
  const before = JSON.stringify(h.world.view());
  await h.action({ build_plan: { id: plan.id, stage: 1 } }, 'gpt');
  assert.equal(JSON.stringify(h.world.view()), before);
  assert.equal(h.plans.view().plans[0].status, 'blocked');
  await h.action({ plan_cancel: { id: plan.id } });
  assert.equal(h.plans.view().plans[0].status, 'cancelled');
});

test('stage persistence errors broadcast already changed blocks and avatars once, without claiming completion or applying again', async (t) => {
  const h = fixture(t);
  const plan = await h.request();
  h.events.length = 0;
  const avatars = JSON.stringify(h.world.avatars);
  const log = JSON.stringify(h.world.log);
  let executions = 0;
  h.plans.execute = () => {
    executions++;
    h.world.blocks.set('6,1,6', 'stone');
    throw new Error('gpt-6-astra PRIVATE-stage-record-write-failed');
  };
  h.world.apply = () => { throw new Error('Must not replay raw world operations'); };
  h.world.applyCells = () => { throw new Error('Must not reapply a stage'); };
  await h.action({ build_plan: { id: plan.id, stage: 1 }, move: [30, 30] });
  assert.equal(executions, 1);
  assert.equal(h.world.blocks.get('6,1,6'), 'stone');
  assert.equal(JSON.stringify(h.world.avatars), avatars);
  assert.equal(JSON.stringify(h.world.log), log);
  assert.deepEqual(h.events.map((e) => e.type), ['world', 'avatars', 'msg']);
  assert.deepEqual(h.events[0].data.changes, [[6, 1, 6, 'stone']]);
  assert.deepEqual(h.events[1].data, createPublicIdentity().project(h.world.avatarView()));
  assert.match(h.events[2].data.text, /블록은 보존되었지만 진행 기록 확인이 필요합니다/);
  assert.equal(h.events[2].data.kind, 'error');
  assert.doesNotMatch(h.events[2].data.text, /완료|완공|PRIVATE|gpt-|1\/4/);
});

test('raw previews reject >24 changes without defining blocks, logging, moving or partially building', async (t) => {
  const h = fixture(t);
  const before = JSON.stringify(h.world.view());
  await h.action({ build: fill(25, 'test_tile'), block_define: definition, move: [30, 30] });
  assert.equal(JSON.stringify(h.world.view()), before);
  assert.equal(h.world.log.length, 0);
  assert.equal(h.world.custom.test_tile, undefined);
  assert.match(h.store.messages.at(-1).text, /24/);
  await h.action({ build: fill(24, 'test_tile'), block_define: definition });
  assert.equal(h.world.blocks.size, 24);
  assert.ok(h.world.custom.test_tile);
  assert.equal(h.world.log.length, 1);
  await h.action({ build: fill(25, 'test_tile') }); // only the final cell changes
  assert.equal(h.world.blocks.size, 25);
});

test('raw preflight protects reserved air and added/deleted signs, including the whole batch', async (t) => {
  const h = fixture(t);
  await h.request();
  for (const build of [
    [...fill(1), { op: 'place', at: [12, 20, 12], block: 'stone' }],
    [{ op: 'sign', at: [12, 20, 12], text: 'NO' }],
  ]) {
    const before = JSON.stringify(h.world.view());
    await h.action({ build, block_define: definition });
    assert.equal(JSON.stringify(h.world.view()), before);
  }
  h.world.signs['12,20,12'] = { text: 'externally added', facing: 's' };
  const before = JSON.stringify(h.world.view());
  await h.action({ build: [{ op: 'remove', at: [12, 20, 12] }] });
  assert.equal(JSON.stringify(h.world.view()), before);
  await h.action({ build: [{ op: 'sign', at: [12, 20, 12], text: '' }] });
  assert.equal(JSON.stringify(h.world.view()), before);
  await h.action({ build: fill(1) });
  assert.equal(h.world.blocks.size, 1);
});

test('GET /api/plans serves a safe view, has no POST action and contains no model names', async (t) => {
  const h = fixture(t);
  const plan = await h.request('claude', { ...request, title: 'gpt-6-astra cottage' });
  const response = await h.api('GET', '/api/plans');
  assert.equal(response.status, 200);
  assert.equal(response.body.plans[0].id, plan.id);
  assert.equal(response.body.plans[0].nextStage, 1);
  assert.doesNotMatch(JSON.stringify(response.body), /gpt-6-astra|xhigh|expectedCells|stageChecksums/);
  assert.doesNotMatch(SOURCE, /req\.method === 'POST' && p === '\/api\/plans'/);
});

test('plan_request suppresses self boost and lookup follow-ups, creating no additional model call', async (t) => {
  const h = fixture(t, { action: { action: 'pass', boost: 'need design help', plan_request: request,
    world_look: {}, world_shot: {}, open: 'unrelated.md' } });
  h.agents.gpt.reason = 'idle';
  await h.runTurn(h.agents.gpt);
  assert.equal(h.chats.length, 1);
  assert.equal(h.chats[0].opts.boost, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.room.calls, 2);
  assert.equal(h.world.blocks.size, 0);
  assert.equal(h.agents.gpt.status, 'idle');
});

test('disabled planning has explicit localized instructions instead of inviting new requests', async (t) => {
  const h = fixture(t, { config: { planner: { enabled: false } } });
  for (const lang of ['ko', 'en', 'ja']) {
    i18n.setLang(lang);
    const brief = prompts.plannerBrief(h.cfg);
    assert.match(brief, /꺼져|disabled|オフ/);
    for (const id of members.AI_IDS) {
      assert.ok(prompts.buildBrief(id, h.cfg).includes(brief));
      const turn = prompts.buildTurn(id, { store: h.store, cfg: h.cfg, agent: h.agents[id], reason: 'idle', plans: 'DO_NOT_SHOW_ACTIVE_PLANS' });
      assert.ok(turn.includes(brief));
      assert.ok(!turn.includes('DO_NOT_SHOW_ACTIVE_PLANS'));
    }
  }
  await h.request();
  assert.equal(h.calls.length, 0);
  assert.equal(h.world.blocks.size, 0);
});

test('living mode rejects all construction while preserving reachable furniture and movement', async t => {
  const h = fixture(t, { config: { constructionEnabled: false, planner: { enabled: true } } });
  assert.equal(h.cfg.planner.enabled, false);
  h.world.apply([{ op: 'place', at: [2,1,2], block: 'planks', shape: 'chair', facing: 'n' }], 'gpt');
  h.world.move('gpt', [2,1]);
  const before = JSON.stringify([...h.world.blocks]);
  const ledger = JSON.stringify(h.plans.state);
  const removed = { plan_request: request, build_plan: {id:'missing',stage:'next'},
    plan_pause: {id:'missing'}, plan_cancel: {id:'missing'}, build: fill(2), block_define: definition };
  await h.performWorldAction(h.agents.gpt, { ...removed, useFurniture: [2,1,2] });
  assert.equal(h.world.avatarView().gpt.posture, 'sit');
  await h.performWorldAction(h.agents.gpt, { ...removed, move: [3,1] });
  assert.equal(h.world.avatarView().gpt.x, 3);
  assert.equal(h.world.avatarView().gpt.z, 1);
  assert.equal(JSON.stringify([...h.world.blocks]), before);
  assert.equal(JSON.stringify(h.plans.state), ledger);
  assert.equal(h.world.custom.test_tile, undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.events.filter(e => e.type === 'world' || e.type === 'worldblocks' || e.type === 'plans').length, 0);
});

test('living mode omits construction prompts and cannot dispatch old planner queues', async t => {
  const h = fixture(t, { config: { constructionEnabled: false }, action: {
    action:'pass', plan_request:request, build:fill(1), block_define:definition, move:[3,1],
    image:{photocard:true,prompt:'함께 차를 마시는 장면',subjects:['아디나']},
  } });
  for (const key of ['processNext','nextContinuation','whimCue','summary']) h.plans[key] = () => { throw Error('Removed planner capability invoked'); };
  await h.processPlanQueue(); await h.continuePlan();
  const act = await h.ask(h.agents.gpt, 'new');
  for (const key of worldActions.CONSTRUCTION_ACTIONS) assert.equal(Object.hasOwn(act,key), false);
  assert.deepEqual(Array.from(act.move), [3,1]);
  assert.equal(act.image.photocard, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.chats.length, 1);
  assert.doesNotMatch(h.chats[0].brief, /plan_request|build_plan|block_define|"build"/);
});

test('whim is obtained once per ask despite repeated history rebuilding; all prompts retain the final voice cue', async (t) => {
  const h = fixture(t, { maxPromptChars: 1 });
  let offers = 0;
  h.plans.whimCue = () => { offers++; return 'optional'; };
  const plan = await h.request();
  for (const language of ['ko', 'en', 'ja']) {
    i18n.setLang(language);
    for (const id of members.AI_IDS) {
      const brief = prompts.buildBrief(id, h.cfg);
      for (const action of ['plan_request', 'build_plan', 'plan_cancel']) assert.ok(brief.includes(action));
      assert.ok(brief.includes('24'));
      const turn = prompts.buildTurn(id, { store: h.store, cfg: h.cfg, agent: h.agents[id], reason: 'idle',
        world: h.world.summary(id, members.displayName), plans: h.plans.summary(), whim: id === 'gemini' });
      assert.ok(turn.includes(plan.ref));
      assert.ok(turn.includes('0/4'));
      const cue = personaTurnCue(id, { turnCount: 0, work: false });
      assert.ok(turn.lastIndexOf(cue) > turn.indexOf(plan.ref));
      assert.ok(turn.indexOf(cue) > turn.indexOf('24시간'));
    }
  }
  i18n.setLang('ko');
  await h.ask(h.agents.gemini, 'spark', null);
  assert.equal(offers, 1);
  assert.match(h.chats[0].turn, /비앙카교/);
});

test('example configuration documents the defaults without depending on a private live config or backup', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.deepEqual(example.planner, { ...DEFAULT_PLANNER_CFG, enabled: false });
  assert.equal(example.basePath, '/chat');
  assert.equal(example.agents.gpt.model, 'gpt-6.1-sol');
  assert.equal(example.agents.claude.model, 'sonnet');
  assert.equal(example.agents.deepseek.model, 'deepseek-ai/deepseek-v4.1-flash');
  assert.equal(example.agents.gemini.model, 'gemini-3.8-flash-medium');
});

test('plan-only JSON actions parse without an obligatory chat bubble', () => {
  assert.deepEqual(prompts.parseAction('{"build_plan":{"id":"p","stage":1}}'), { build_plan: { id: 'p', stage: 1 } });
  assert.equal(prompts.parseAction('{"plan_request":'), null);
});

test('explicit continuation grows one <=80-cell chunk per due time with zero extra model calls and only phase notices', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = fixture(t, { planner: () => ({ ok: true, text: JSON.stringify({ ...recipe, origin: [1, 1], size: [11, 11] }) }) });
  const plan = await h.request();
  await h.continuePlan();
  assert.equal(h.world.blocks.size, 0);
  assert.equal(h.plans.nextContinuation(), null);
  h.events.length = 0;
  await h.action({ build_plan: { id: '#1', stage: 'next', continue: true } }, 'gpt');
  assert.equal(h.world.blocks.size, 80);
  assert.equal(h.plans.view().plans[0].stageOffset, 80);
  const afterStart = h.store.messages.length;
  await h.continuePlan();
  assert.equal(h.world.blocks.size, 80);
  let ticks = 0;
  while (h.plans.view().plans[0].status !== 'complete') {
    assert.ok(++ticks < 30);
    now += ticks === 1 ? 600000 : 25000; // delayed wake must not catch up in a burst
    const before = h.world.blocks.size;
    await h.continuePlan();
    assert.ok(h.world.blocks.size > before);
    assert.ok(h.world.blocks.size - before <= 80);
    const justBuilt = h.world.blocks.size;
    await h.continuePlan();
    assert.equal(h.world.blocks.size, justBuilt);
  }
  assert.equal(h.world.blocks.size, plan.count);
  assert.equal(h.plans.nextContinuation(), null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.chats.length, 0);
  assert.equal(h.room.calls, 1);
  const notices = h.store.messages.slice(afterStart);
  assert.equal(notices.length, 4);
  assert.ok(notices.every((m) => m.continuation === true && m.planProgress.advanced));
  const batches = h.events.filter((e) => e.type === 'world');
  assert.ok(batches.every((e) => e.data.changes.length <= 80));
});

test('scheduled construction preserves a seated builder while manual initial construction still moves them', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = fixture(t, { planner: () => ({ ok: true, text: JSON.stringify({ ...recipe, origin: [1, 1], size: [11, 11] }) }) });
  await h.request();
  await h.action({ build: [{ op: 'place', at: [20, 1, 20], block: 'planks', shape: 'chair', facing: 'n' }] });
  await h.action({ useFurniture: [20, 1, 20] }, 'gpt');
  assert.equal(h.world.avatarView().gpt.posture, 'sit');

  // Deliberately choosing the first build still moves the member to the site.
  h.events.length = 0;
  await h.action({ build_plan: { id: '#1', stage: 'next', continue: true } }, 'gpt');
  const firstBatch = h.events.find((e) => e.type === 'world').data.changes;
  const lastCell = firstBatch.at(-1);
  assert.equal(firstBatch.length, 80);
  assert.equal(h.world.avatarView().gpt.posture, 'stand');
  assert.equal(h.world.avatars.gpt.x, lastCell[0]);
  assert.equal(h.world.avatars.gpt.z, lastCell[2] + 1);
  assert.equal(h.world.avatars.gpt.furniture, undefined);

  // The member chooses to sit elsewhere while their reserved work continues.
  await h.action({ useFurniture: [20, 1, 20] }, 'gpt');
  const seated = structuredClone(h.world.avatars.gpt);
  const { path: seatedRoute, moveId: seatedMove, ...seatedView } = structuredClone(h.world.avatarView().gpt);
  assert.ok(Array.isArray(seatedRoute) && Number.isFinite(seatedMove));
  assert.equal(seatedView.posture, 'sit');
  let chunks = 0;
  while (h.plans.view().plans[0].status !== 'complete') {
    assert.ok(++chunks < 30);
    now += 25000;
    const before = h.world.blocks.size;
    h.events.length = 0;
    await h.continuePlan();
    assert.ok(h.world.blocks.size > before && h.world.blocks.size - before <= 80);
    assert.deepEqual(h.world.avatars.gpt, seated);
    assert.deepEqual(h.world.avatarView().gpt, seatedView);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.world.file, 'utf8')).avatars.gpt, seated);
    assert.deepEqual(h.events.find((e) => e.type === 'avatars').data.adina, seatedView);
  }
  assert.ok(chunks > 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.chats.length, 0);
});

test('continuations cannot wake stopped or sleeping rooms, postpone auto-sleep, or ignore pause/cancel', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = fixture(t);
  await h.request();
  await h.action({ build_plan: { id: '#1', stage: 'next', continue: true } }, 'gpt');
  const before = h.world.blocks.size;
  h.stopRoom(); now += 25000;
  h.tick(); await h.continuePlan();
  assert.equal(h.room.running, false);
  assert.equal(h.world.blocks.size, before);
  h.startRoom(); h.room.sleeping = true;
  await h.continuePlan();
  assert.equal(h.world.blocks.size, before);
  h.room.sleeping = false;
  h.room.autoSleepMin = 1; h.room.lastUserAt = now - 60001;
  h.tick();
  assert.equal(h.room.sleeping, true);
  assert.equal(h.world.blocks.size, before);
  h.startRoom();
  await h.action({ plan_pause: { id: '#1' } }, 'gpt');
  await h.continuePlan();
  assert.equal(h.world.blocks.size, before);
  assert.equal(h.plans.nextContinuation(), null);
  assert.match(h.store.messages.at(-1).text, /일시정지/);
  await h.action({ build_plan: { id: '#1', stage: 'next', continue: true } }, 'gpt');
  assert.ok(h.world.blocks.size > before);
  await h.action({ plan_cancel: { id: '#1' } }, 'claude');
  const cancelled = h.world.blocks.size; now += 25000;
  await h.continuePlan();
  assert.equal(h.world.blocks.size, cancelled);
  assert.equal(h.plans.nextContinuation(), null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.chats.length, 0);
});

test('ordinary stage choice never schedules, and a duplicate has a neutral factual notice without success or geometry', async (t) => {
  const h = fixture(t);
  await h.request();
  await h.action({ build_plan: { id: '#1', stage: 'next' } }, 'gpt');
  assert.equal(h.plans.nextContinuation(), null);
  h.events.length = 0;
  assert.equal(await h.action({ build_plan: { id: '#1', stage: 1 } }, 'gpt'), false);
  assert.deepEqual(h.events.map((e) => e.type), ['msg']);
  const notice = h.store.messages.at(-1);
  assert.equal(notice.kind, 'info');
  assert.match(notice.text, /이미 완료.*새 블록 0칸.*stage:"next"/);
  assert.doesNotMatch(notice.text, /📐|짓는 중|기초·바닥/);
  assert.equal(notice.planProgress.duplicate, true);
  assert.equal(notice.planProgress.advanced, false);
  assert.equal(notice.planProgress.nextStage, 2);
});

test('busy requests receive one durable queue receipt and dispatch automatically after the short wait', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let resolve, launched=0;
  const h = fixture(t, { planner: () => ++launched === 1 ? new Promise((r) => { resolve = r; })
    : {ok:true,text:JSON.stringify({...recipe,origin:[18,2]})} });
  const pending = h.action({ plan_request: request });
  await Promise.resolve();
  await h.action({ plan_request: { title: 'Other', brief: 'Another house', site: [16, 0, 29, 13] } }, 'gpt');
  const queued=h.plans.view().plans[1];
  assert.equal(queued.status,'queued');assert.equal(queued.queuePosition,1);
  assert.match(h.store.messages.at(-1).text,/접수.*대기 1번/);
  assert.equal(h.store.messages.some(m=>m.planError?.code==='planner_busy'),false);
  assert.equal(h.calls.length, 1);
  resolve({ ok: true, text: JSON.stringify(recipe) }); await pending;
  h.room.running=false;now+=15000;await h.processPlanQueue();assert.equal(h.calls.length,1);
  h.room.running=true;await h.processPlanQueue();assert.equal(h.calls.length,2);
  assert.equal(h.plans.view().plans[1].status,'draft');
  assert.equal(h.world.blocks.size,0);
  await h.action({ build_plan: { id: '#1', stage: 'next' } }, 'gpt');
  now += 5000;
  await h.action({ build_plan: { id: '#1', stage: 'next' } }, 'gemini');
  const error = h.store.messages.at(-1);
  assert.equal(error.planError.code, 'stage_cooldown');
  assert.equal(error.planError.retryAfterSec, 20);
  assert.equal(error.planError.nextStage, 2);
  assert.match(error.text, /20초/);
  assert.equal(h.calls.length, 2);
});

test('scheduled failure pauses rather than repeatedly retrying, keeps WAL, and surfaces the failure', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = fixture(t);
  await h.request();
  await h.action({ build_plan: { id: '#1', stage: 'next', continue: true } }, 'gpt');
  let attempts = 0;
  h.world.applyCells = () => { attempts++; throw Error('private disk failure'); };
  now += 25000;
  await h.continuePlan();
  const p = h.plans.view().plans[0];
  assert.equal(p.pending, true);
  assert.equal(p.continuation.paused, true);
  assert.equal(h.plans.nextContinuation(), null);
  const error = h.store.messages.at(-1);
  assert.equal(error.kind, 'error');
  assert.equal(error.planError.code, 'plan_io_error');
  assert.equal(error.continuation, true);
  assert.doesNotMatch(error.text, /private/);
  for (let i = 0; i < 5; i++) { now += 30000; await h.continuePlan(); }
  assert.equal(attempts, 1);
  assert.equal(h.calls.length, 1);
});

test('furniture JSON actions use actual geometry, broadcast factual poses, and report missing/occupied furniture', async (t) => {
  const h = fixture(t);
  await h.action({ build: [{ op: 'place', at: [20, 1, 20], block: 'planks', shape: 'chair', facing: 'n' }] });
  h.events.length = 0;
  await h.action({ useFurniture: [20, 1, 20] }, 'gpt');
  assert.deepEqual(h.events.map((e) => e.type), ['avatars', 'msg']);
  assert.equal(h.events[0].data.adina.posture, 'sit');
  assert.equal(h.store.messages.at(-1).furnitureUse.posture, 'sit');
  h.events.length = 0;
  await h.action({ useFurniture: [20, 1, 20] }, 'gemini');
  assert.deepEqual(h.events.map((e) => e.type), ['msg']);
  assert.equal(h.store.messages.at(-1).furnitureError, 'occupied');
  assert.match(h.store.messages.at(-1).text, /다른 멤버가 사용 중/);
  await h.action({ useFurniture: [19, 1, 19] });
  assert.equal(h.store.messages.at(-1).furnitureError, 'not_furniture');
  await h.action({ useFurniture: ['20', 1, 20] });
  assert.match(h.store.messages.at(-1).text, /정수 좌표/);
  h.room.running = false;
  const before = JSON.stringify(h.world.avatars);
  await h.action({ useFurniture: [20, 1, 20] });
  assert.equal(JSON.stringify(h.world.avatars), before);
  assert.equal(h.calls.length, 0);
  assert.equal(h.chats.length, 0);
});

test('all prompt languages explain voluntary continuation, current-state next and furniture actions without requiring opt-in', (t) => {
  const h = fixture(t);
  for (const lang of ['ko', 'en', 'ja']) {
    i18n.setLang(lang);
    const brief = prompts.buildBrief('gpt', h.cfg);
    for (const token of ['"continue":true', '80', '25', 'plan_pause', '"stage":"next"', 'useFurniture', 'chair', 'bench', 'bed', 'workbench']) assert.ok(brief.includes(token), `${lang}: ${token}`);
    assert.doesNotMatch(brief, /five-minute|최소 5분|最低5分/);
    assert.ok(brief.includes('"build_plan": {"id": "#1", "stage": "next"}'));
  }
  assert.deepEqual(prompts.parseAction('{"plan_pause":{"id":"#1"}}'), { plan_pause: { id: '#1' } });
  assert.deepEqual(prompts.parseAction('{"useFurniture":[20,1,20]}'), { useFurniture: [20, 1, 20] });
});

const adminHeaders = { host:'localhost:0', origin:'http://localhost:0', 'content-type':'application/json' };
async function loginAdmin(h) {
  const password=fs.readFileSync(path.join(h.home,'data/admin-password.txt'),'utf8').trim();
  const result=await h.api('POST','/api/admin/login',{password},adminHeaders);
  assert.equal(result.status,200);
  assert.equal(result.body.role,'admin');
  return { ...adminHeaders, cookie:result.headers['Set-Cookie'].split(';')[0] };
}

test('browser APIs require administrator login for every mutation, even on localhost', async t => {
  const h=fixture(t); const before=JSON.stringify(h.room), lastId=h.store.lastId;
  for(const endpoint of ['/api/room','/api/member','/api/send','/api/react','/api/usage/refresh']) {
    assert.equal((await h.api('POST',endpoint,{running:false,speed:'fast',id:'claude',enabled:false,text:'impersonation'},adminHeaders)).status,401);
  }
  assert.equal(JSON.stringify(h.room),before); assert.equal(h.store.lastId,lastId);
  assert.equal((await h.api('GET','/api/admin/settings')).status,401);
  assert.equal((await h.api('GET','/api/usage')).status,401);
  const publicState=(await h.api('GET','/api/state')).body;
  assert.equal(publicState.session.role,'viewer');assert.equal(publicState.usage,undefined);
  assert.equal(publicState.room.speed,undefined);assert.equal(publicState.room.calls,undefined);
  assert.equal(publicState.members[0].model,undefined);assert.equal(publicState.members[0].lastError,undefined);
  assert.equal(publicState.batteries,undefined);assert.equal(publicState.sleeps.eleven.state,'awake');
  const headers=await loginAdmin(h);
  assert.equal((await h.api('POST','/api/room',{speed:'fast'},headers)).status,200);
  assert.equal(h.room.speed,'fast');
  assert.equal((await h.api('GET','/api/admin/settings',undefined,headers)).body.speed,'fast');
  assert.equal((await h.api('POST','/api/room',{speed:'slow'},{...headers,origin:'http://attacker.invalid'})).status,403);
  assert.equal(h.room.speed,'fast');
  assert.equal((await h.api('POST','/api/room',{speed:'slow'},{cookie:headers.cookie,'content-type':'application/json'})).status,403);
  assert.equal((await h.api('POST','/api/admin/logout',{},headers)).body.role,'viewer');
  assert.equal((await h.api('POST','/api/room',{speed:'slow'},headers)).status,401);
  assert.equal(h.room.speed,'fast');
});

test('SSE projects only public fields for every connection and revokes an open admin connection on logout', async t => {
  const h=fixture(t), headers=await loginAdmin(h), frames=[];
  const req={headers,socket:{remoteAddress:'127.0.0.1',encrypted:false}};
  const client={write:frame=>frames.push(frame)};
  h.clients.add(client);h.clientAuth.set(client,{req,role:'admin'});
  h.broadcast('room',{running:true,sleeping:false,roomName:'ERCraft',userName:'ERCraft',speed:'fast',calls:991,boostMode:'private'});
  h.broadcast('members',[{id:'claude',name:'일레븐',model:'private-model',calls:987}]);
  h.broadcast('usage',{claude:{ok:true,at:Date.now(),plan:'private-plan',windows:[{remainingPct:82.37}]}});
  h.broadcast('msg',{id:111,from:'claude',text:'대화 원문',model:'private-model',boostWhy:'private-why'});
  const combined=frames.join('');
  assert.doesNotMatch(combined,/private|991|987|82\.37|"calls"|"speed"|event: usage/);
  assert.doesNotMatch(combined,/event: batteries/);assert.match(combined,/대화 원문/);
  await h.api('POST','/api/admin/logout',{},headers);
  assert.match(frames.at(-1),/event: session.*\n.*"role":"viewer"/);
});

test('session revocation while a body is arriving prevents the mutation after await', async t => {
  const h=fixture(t),headers=await loginAdmin(h);h.room.speed='normal';
  const req=new Readable({read(){}});req.method='POST';req.headers=headers;
  Object.defineProperty(req,'socket',{value:{remoteAddress:'127.0.0.1',encrypted:false}});
  let code;const pending=h.handleApi(req,{writeHead(c){code=c;},end(){}},new URL('http://localhost:0/api/room'));
  h.admin.logout(req);
  req.push(Buffer.from('{"speed":"fast"}'));req.push(null);await pending;
  assert.equal(code,401);assert.equal(h.room.speed,'normal');
});

test('workspace junctions cannot expose private administrator data through file APIs', async t => {
  const h=fixture(t); const link=path.join(h.home,'workspace/private');
  fs.symlinkSync(path.join(h.home,'data'),link,process.platform==='win32'?'junction':'dir');
  const result=await h.api('GET','/api/file?path=private/admin-password.txt');
  assert.equal(result.status,404);assert.equal(result.body.text,undefined);
  assert.equal((await h.api('GET','/api/state')).body.files.some(f=>f.path.startsWith('private')),false);
  for(const url of ['/ws/private/admin-password.txt','/data/admin-password.txt','/config.json','/..%2fdata/admin-password.txt']) {
    let status;await h.handleRequest({method:'GET',url,headers:{host:'localhost:0'}},{writeHead(code){status=code;},end(){}});
    assert.equal(status,404);
  }
});

test('malformed request targets return 400 without trusting Host for URL parsing', async t => {
  const h=fixture(t);let status,body;
  const res={writeHead(code){status=code;},end(value){body=value;}};
  await h.handleRequest({method:'GET',url:'http://[',headers:{host:'['}},res);
  assert.equal(status,400);
  await h.handleRequest({method:'GET',url:'/api/session',headers:{host:'['}},res);
  assert.equal(status,200);assert.equal(JSON.parse(body).role,'viewer');
});

test('silence follows the speed preset and pass rotates within the configured backoff cap', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  // Keep scheduled game announcements from turning this silence test into a reply test.
  const h=fixture(t,{config:{spark:{enabled:true}},liarStartAt:now+24*60*60*1000});
  h.room.autoSleepMin=0;h.room.startedAt=now;
  for(const id of members.AI_IDS){h.cfg.agents[id].participation=1;h.agents[id].seen=h.store.lastId;}
  const sp = pacing(h), after = h.cfg.spark.afterSec || sp.spark;
  const maxWait = h.cfg.spark.maxWaitSec || sp.sparkMax;
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  h.tick();await flush();
  assert.equal(h.chats.length,0);
  assertDelay(h.spark.wait, 0, after.map(seconds => Math.min(seconds, maxWait)));
  now = Math.ceil(h.spark.base + h.spark.wait) - 1;
  h.tick();await flush();assert.equal(h.chats.length,0);
  now+=1;h.tick();await flush();assert.equal(h.chats.length,1);
  let previous=h.chats.at(-1).id;
  for(let n=2;n<=8;n++){
    h.tick();await flush();
    assert.equal(h.spark.streak, n - 1);
    const backoff = h.cfg.spark.backoff ** (n - 1);
    assertDelay(h.spark.wait, 0, after.map(seconds => Math.min(seconds * backoff, maxWait)));
    now = Math.ceil(Math.max(h.spark.base, h.spark.lastEnd) + h.spark.wait) - 1;
    h.tick();await flush();assert.equal(h.chats.length,n-1);
    now+=1;h.tick();await flush();assert.equal(h.chats.length,n);
    assert.notEqual(h.chats.at(-1).id,previous);previous=h.chats.at(-1).id;
  }
  assert.equal(h.store.messages.filter(m=>members.AI_IDS.includes(m.from)).length,0,'pass stays silent');
});

test('silence turns defer to responses, images, active designs and voluntary construction', t => {
  const now=Date.now(),h=fixture(t,{config:{spark:{enabled:true}}});
  h.room.startedAt=now-600000;h.spark.base=h.room.startedAt;h.spark.wait=0;
  const attempts=[
    ()=>{h.room.running=false;return()=>h.room.running=true;},
    ()=>{h.room.sleeping=true;return()=>h.room.sleeping=false;},
    ()=>{h.agents.gpt.busy=true;return()=>h.agents.gpt.busy=false;},
    ()=>{h.agents.gpt.imageBusy=true;return()=>h.agents.gpt.imageBusy=false;},
    ()=>{h.plans.state.inflight={};return()=>h.plans.state.inflight=null;},
    ()=>{h.plans.state.plans=[{status:'building',continuation:{paused:false}}];return()=>h.plans.state.plans=[];},
  ];
  for(const setup of attempts){const restore=setup();h.maybeSpark(now,h.SPEEDS.normal);assert.equal(h.spark.who,null);restore();}
  h.maybeSpark(now,h.SPEEDS.normal);assert.ok(h.spark.who);
});

test('a selected silence turn cannot overtake new work and auto sleep still follows administrator inactivity', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const h=fixture(t,{config:{spark:{enabled:true}}});
  h.room.startedAt=now-600000;h.room.lastUserAt=now-29*60000;
  h.agents.gpt.reason='spark';h.agents.gpt.wakeAt=now-1;h.agents.gemini.busy=true;
  h.tick();for(let i=0;i<20;i++)await Promise.resolve();assert.equal(h.chats.length,0);
  h.agents.gemini.busy=false;
  now+=60001;h.tick();assert.equal(h.room.running,false);assert.equal(h.room.sleeping,true);assert.equal(h.chats.length,0);
});

test('developer back-and-forth guard still blocks silence calls', t => {
  const h=fixture(t,{config:{spark:{enabled:true},dev:{enabled:true}},devChainState:()=>({why:'test guard'})});
  h.room.autoSleepMin=0;h.room.startedAt=Date.now()-600000;
  h.tick();assert.equal(h.chats.length,0);assert.equal(h.spark.who,null);
});

test('fresh conversation cancels a held silence turn and uses normal reply delay', async t => {
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  const h=fixture(t,{config:{spark:{enabled:true}}});h.room.autoSleepMin=0;h.room.startedAt=now-600000;
  for(const id of members.AI_IDS){h.agents[id].seen=h.store.lastId;h.cfg.agents[id].participation=1;}
  h.spark.base=h.room.startedAt;h.spark.wait=0;h.maybeSpark(now,h.SPEEDS.normal);
  const chosen=h.spark.who,other=members.AI_IDS.find(id=>id!==chosen);assert.ok(chosen);
  h.agents[other].busy=true;h.tick();assert.equal(h.chats.length,0);
  h.store.addMessage({from:other,text:'창가에 빗방울이 맺혔네.'});h.agents[other].busy=false;
  h.tick();for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(h.chats.length,0,'no stale spark call immediately after fresh speech');
  assert.equal(h.spark.who,null);assert.equal(h.agents[chosen].reason,'new');
  const batched = chosen === 'gemini' || conversationEfficiency.efficientConversation(chosen, h.cfg);
  assertDelay(h.agents[chosen].wakeAt, now, batched ? batchRead(h, chosen) : pacing(h).read);
});

test('an old provider image URL is blocked without redirect while neutral images remain public', async t => {
  const h=fixture(t),old='images/gpt-20261001-160001.png',renamed='images/ERCraft-20261001-160001.png';
  const png = tinyPng();
  fs.mkdirSync(path.join(h.home,'workspace/images'));fs.writeFileSync(h.store.abs(renamed),png);
  h.imageAliases.set(old,renamed);
  const result=await h.api('GET','/api/file?path='+old);
  assert.equal(result.status,404);
  const current=await h.api('GET','/api/file?path='+renamed);
  assert.equal(current.status,200);assert.equal(current.body.rel,renamed);assert.equal(current.body.size,png.length);
  assert.deepEqual((await h.api('GET','/api/state')).body.files.map(f=>f.path),[renamed]);
  let status,headers;
  await h.handleRequest({method:'GET',url:'/ws/'+old,headers:{}},{writeHead(s,h){status=s;headers=h;},end(){}});
  assert.equal(status,404);assert.equal(headers?.Location,undefined);
  fs.unlinkSync(h.store.abs(renamed));
  await h.handleRequest({method:'GET',url:'/ws/'+old,headers:{}},{writeHead(s){status=s;},end(){}});
  assert.equal(status,404);
});

// Real loopback HTTP/SSE transport around the existing isolated VM server. The
// production listener, room, adapters and timers are never started by these tests.
async function publicWire(t,h) {
  const listener=http.createServer(h.handleRequest);
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  t.after(()=>{listener.closeAllConnections();listener.close();});
  const port=listener.address().port;
  const request=(pathname,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers:{host:'localhost:0',...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks),text:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const events=(headers={})=>new Promise((resolve,reject)=>{
    const req=http.get({hostname:'127.0.0.1',port,path:'/events',headers:{host:'localhost:0',...headers}},res=>{
      let text='';const waiters=[];
      res.on('data',chunk=>{text+=chunk.toString();for(const wake of waiters.splice(0))wake();});
      res.once('data',()=>resolve({read:()=>text,async until(expected){
        const timeout=setTimeout(()=>req.destroy(new Error('SSE timeout')),3000);
        try { while(!text.includes(expected)) await new Promise((resolve,reject)=>{waiters.push(resolve);req.once('error',reject);}); }
        finally{clearTimeout(timeout);}
      },close:()=>req.destroy()}));
    });req.on('error',reject);t.after(()=>req.destroy());
  });
  return {request,events};
}

test('real public HTTP and SSE use one public contract for viewers and admins, preserving raw saved data', async t=>{
  const h=fixture(t,{room:{running:false,sleeping:false},config:{agents:{gpt:{model:'private-route-v7'}}}});
  const raw=h.store.addMessage({from:'claude',by:'grok',text:'Claude private-route-v7라고 했어. 내 평범한 말투! ㅋㅋ',reactions:{'👍':['gpt','gemini','deepseek','grok']},attach:{path:'OpenAI/notes.txt',desc:'OpenAI 묘사'}});
  h.store.writeNote('gpt','클로드와 private-route-v7');
  h.store.applyFileOp({op:'write',path:'OpenAI/notes.txt',content:'Gemini provider text, 평범한 문장.'},'gpt');
  h.world.custom.claude_tile={by:'claude',pixels:Array(8).fill('aaaaaaaa'),colors:{a:'#ffffff'}};
  h.world.blocks.set('1,1,1','claude_tile/stair/n');h.world.signs['1,1,1']={by:'grok',text:'OpenAI 간판'};
  const originals={message:fs.readFileSync(h.store.msgFile),note:fs.readFileSync(path.join(h.store.notesDir,'gpt.md')),file:fs.readFileSync(h.store.abs('OpenAI/notes.txt')),world:structuredClone(h.world.view())};
  const wire=await publicWire(t,h),headers=await loginAdmin(h);
  const forbidden=/claude|gpt|gemini|deepseek|grok|openai|private-route-v7|클로드/i;
  for(const session of [{},headers]) {
    for(const endpoint of ['/api/state','/api/history','/api/notes','/api/world','/api/plans']) {
      const response=await wire.request(endpoint,{headers:session});assert.equal(response.status,200,endpoint);assert.doesNotMatch(response.text,forbidden,endpoint);
    }
    const state=JSON.parse((await wire.request('/api/state',{headers:session})).text);
    assert.deepEqual(state.members.map(m=>m.id),['eleven','adina','lucia','bianca']);
    const message=state.messages.find(m=>m.id===raw.id);
    assert.deepEqual(message.reactions['👍'],['adina','bianca','lucia','former-member']);
    assert.equal(message.from,'eleven');assert.match(message.text,/내 평범한 말투! ㅋㅋ/);
    assert.equal(state.members[0].persona.skin.full,'/assets/characters/eleven/full.png');
    const filename=state.files[0].path;assert.match(filename,/private-files\/ERCraft-/);
    const file=await wire.request('/api/file?path='+encodeURIComponent(filename),{headers:session});
    const ws=await wire.request('/ws/'+filename,{headers:session});
    assert.equal(file.status,200);assert.equal(ws.status,200);assert.equal(JSON.parse(file.text).text,ws.text);assert.doesNotMatch(file.text,forbidden);
    const stream=await wire.events(session);
    h.broadcast('msg',raw);h.broadcast('msgupdate',raw);h.broadcast('members',[{id:'gpt',name:'아디나',legacyAliases:['gpt'],imageGen:true}]);
    h.broadcast('notes',{id:'gpt',text:h.store.readNote('gpt')});h.broadcast('worldblocks',h.world.custom);h.broadcast('world',{by:'claude',changes:[[1,1,1,'claude_tile/stair/n']]});
    h.broadcast('avatars',h.world.avatarView());h.broadcast('signs',h.world.signs);h.broadcast('ws',h.store.listFiles());
    h.broadcast('plans',{plans:[{owner:'gpt',title:'private-route-v7',stages:[{name:'OpenAI'}]}]});
    h.broadcast('room',h.room);h.broadcast('usage',{claude:{ok:true,at:Date.now(),windows:[{remainingPct:50}]}});
    await stream.until('event: worldblocks');assert.doesNotMatch(stream.read(),forbidden);assert.doesNotMatch(stream.read(),/event: batteries/);stream.close();
  }
  for(const endpoint of ['/api/admin/raw/state','/api/admin/raw/plans','/api/admin/raw/file?path=OpenAI/notes.txt'])assert.equal((await wire.request(endpoint)).status,401);
  assert.match((await wire.request('/api/admin/raw/state',{headers})).text,/private-route-v7/);
  assert.match((await wire.request('/api/admin/raw/file?path=OpenAI/notes.txt',{headers})).text,/Gemini/);
  assert.deepEqual(fs.readFileSync(h.store.msgFile),originals.message);assert.deepEqual(fs.readFileSync(path.join(h.store.notesDir,'gpt.md')),originals.note);
  assert.deepEqual(fs.readFileSync(h.store.abs('OpenAI/notes.txt')),originals.file);assert.deepEqual(h.world.view(),originals.world);
  assert.equal(h.calls.length,0);assert.equal(h.chats.length,0);
});

test('real HTTP gates unsafe files and old aliases, keeps optional art absent or sanitized and safe workspace copies usable', async t=>{
  const h=fixture(t,{room:{running:false,sleeping:false}}),wire=await publicWire(t,h);
  const sources={ 'safe.svg':'<svg xmlns="http://www.w3.org/2000/svg"><text>그림</text></svg>',
    'game.html':'<!doctype html><button>Play</button>',
    'hidden.svg':'<svg><text>&#67;laude</text></svg>', 'bad.js':'const model="gemini";', 'meta.xml':'<metadata>OpenAI</metadata>' };
  for(const [file,content]of Object.entries(sources))h.store.applyFileOp({op:'write',path:file,content},'gpt');
  const original=tinyPng([pngChunk('caBX',Buffer.from('OpenAI provenance')),pngChunk('tEXt',Buffer.from('Software\0Claude'))]);
  fs.mkdirSync(h.store.abs('images'));fs.writeFileSync(h.store.abs('images/gpt-picture.png'),original);
  const state=JSON.parse((await wire.request('/api/state')).text),image=state.files.find(f=>f.path.endsWith('.png'));
  assert.match(image.path,/private-files\/ERCraft-/);assert.equal(image.available,true);
  for(const route of ['/assets/CHARAC~1/claude/full.png','/assets/CHARAC~1/manifest.json','/lib/public-identity.mjs','/api/file?path=images/gpt-picture.png','/ws/images/gpt-picture.png','/assets/characters/claude/full.png','/assets/characters/gpt/avatar.png','/assets/characters/manifest.json','/ASSETS/CHARACTERS/Claude/full.png','/assets%2fcharacters%2fclaude%2ffull.png','/avatars/claude.svg','/AVATARS/gpt.svg','/avatars%5Cgpt.svg']){
    const r=await wire.request(route);assert.equal(r.status,404,route);assert.equal(r.headers.location,undefined);
  }
  for(const name of ['safe.svg','game.html']) {
    const response=await wire.request('/ws/'+name);assert.equal(response.status,200);assert.equal(response.text,sources[name]);assert.match(response.headers['content-security-policy'],/sandbox/);
    assert.equal(JSON.parse((await wire.request('/api/file?path='+name)).text).text,sources[name]);
  }
  for(const name of ['hidden.svg','bad.js','meta.xml']) {
    assert.equal((await wire.request('/ws/'+name)).status,404);assert.equal((await wire.request('/api/file?path='+name)).status,404);
    assert.equal(state.files.find(f=>f.path===name).available,false);
  }
  const copy=await wire.request('/ws/'+image.path);assert.equal(copy.status,200);assert.deepEqual(copy.body,tinyPng());assert.match(copy.headers['x-image-notice'],/AI-generated/);
  assert.deepEqual(fs.readFileSync(h.store.abs('images/gpt-picture.png')),original);
  // Public clones omit art; private checkouts may retain it. Inspect only the
  // corresponding optional source and require the route's exact safe outcome.
  for (const route of ['/assets/characters/eleven/full.png', '/assets/characters/eleven/full.png?preview=1']) {
    const url = new URL(route, 'http://fixture.invalid');
    const file = path.join(ROOT, 'public', ...(url.searchParams.has('preview') ? ['previews'] : []), resolveCharacterAsset(url.pathname));
    const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
    let safe = null;
    try { safe = readPublicPng(file); } catch { /* Missing or non-public image must fail closed. */ }
    const portrait = await wire.request(route);
    assert.equal(portrait.status, safe ? 200 : 404, route);
    assert.equal(portrait.headers.location, undefined, 'optional art must never redirect to private originals');
    if (safe) {
      assert.equal(portrait.headers['content-type'], 'image/png');
      assert.deepEqual(portrait.body, safe, 'serve the sanitized copy, not original provenance');
      for (let offset = 8; offset < portrait.body.length;) {
        const length = portrait.body.readUInt32BE(offset), type = portrait.body.toString('ascii', offset + 4, offset + 8);
        assert.ok(!['tEXt', 'iTXt', 'zTXt', 'caBX', 'eXIf', 'iCCP'].includes(type), type);
        offset += length + 12;
      }
    }
    if (original) assert.deepEqual(fs.readFileSync(file), original, 'retained local art remains untouched');
  }
  assert.deepEqual((await wire.request('/LICENSE')).body,fs.readFileSync(path.join(ROOT,'LICENSE')));
  const license=await wire.request('/licenses.html');assert.equal(license.status,200);assert.match(license.text,/MIT License/);
});

test('real authenticated member and sticker controls reverse only public identifiers, responses remain projected', async t=>{
  const h=fixture(t,{room:{running:false,sleeping:false}}),wire=await publicWire(t,h),headers=await loginAdmin(h);
  const png=tinyPng();fs.mkdirSync(h.store.abs('stickers/claude'),{recursive:true});fs.writeFileSync(h.store.abs('stickers/claude/test.png'),png);
  const image=JSON.parse((await wire.request('/api/state')).text).files.find(f=>f.path.endsWith('.png'));
  assert.equal(image.sticker,true);
  assert.equal((await wire.request('/api/member',{method:'POST',headers:adminHeaders,body:{id:'eleven',enabled:false}})).status,401);
  assert.equal(h.room.enabled.claude,true);
  assert.equal((await wire.request('/api/member',{method:'POST',headers,body:{id:'claude',enabled:false}})).status,400);
  assert.equal((await wire.request('/api/member',{method:'POST',headers,body:{id:'eleven',enabled:false}})).status,200);assert.equal(h.room.enabled.claude,false);
  assert.equal(h.room.enabled.eleven,undefined);assert.equal(h.store.messages.at(-1).by,'claude');
  assert.equal((await wire.request('/api/send',{method:'POST',headers:adminHeaders,body:{sticker:image.path}})).status,401);
  const sent=await wire.request('/api/send',{method:'POST',headers,body:{sticker:image.path}});assert.equal(sent.status,200);assert.equal(JSON.parse(sent.text).msg.attach.path,image.path);
  assert.equal(h.store.messages.at(-1).attach.path,'stickers/claude/test.png');
  const said=await wire.request('/api/send',{method:'POST',headers,body:{text:'OpenAI Claude'} });assert.equal(said.status,200);assert.doesNotMatch(said.text,/openai|claude/i);
  assert.equal(h.store.messages.at(-1).text,'OpenAI Claude');assert.equal(h.room.running,false);assert.equal(h.calls.length,0);assert.equal(h.chats.length,0);
});

const flushReply = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function geminiBatchFixture(t, options = {}) {
  const h = fixture(t, options);
  h.room.autoSleepMin = 0;
  for (const id of members.AI_IDS) {
    h.room.enabled[id] = id === 'gemini';
    h.agents[id].seen = h.store.lastId;
  }
  return h;
}

test('Gemini coalesces peer mentions once per new message without consuming history early', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = geminiBatchFixture(t), a = h.agents.gemini, seen = a.seen;
  h.store.addMessage({ from: 'gpt', text: '@비앙카 정원에 노란 꽃을 심을까요?' });
  h.tick(); const firstWake = a.wakeAt;
  assertDelay(firstWake, now, batchRead(h));
  for (let i = 0; i < 6; i++) { now += 500; h.tick(); }
  assert.equal(a.wakeAt, firstWake, 'ticks alone must not extend the timer');
  h.store.addMessage({ from: 'deepseek', text: '@비앙카 창가 쪽도 좋겠어요.' });
  h.tick();
  assertDelay(a.wakeAt, now, batchRead(h));
  assert.equal(a.seen, seen); assert.equal(h.chats.length, 0);
  now = Math.ceil(a.wakeAt) - 1; h.tick(); await flushReply();
  assert.equal(h.chats.length, 0, 'the quiet window must finish before reading');
  now += 1; h.tick(); await flushReply();
  assert.equal(h.chats.length, 1);
  assert.match(h.chats[0].turn, /노란 꽃/); assert.match(h.chats[0].turn, /창가 쪽/);
  assert.equal(a.seen, h.store.lastId); assert.equal(a.readBatch, null);
  now += 1000; h.tick(); await flushReply(); assert.equal(h.chats.length, 1);
});

test('continuous Gemini peer traffic reaches the fixed deadline from the speed preset', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = geminiBatchFixture(t), a = h.agents.gemini, start = now;
  const deadline = start + pacing(h).batchMax * 1000;
  for (let i = 0; start + i * 3000 < deadline; i++) {
    now = start + i * 3000;
    // Keep the independent AI-bubble rate cap out of this deadline test.
    // AI peers still open and close the batch; the developer supplies the burst.
    h.store.addMessage({ from: i === 0 ? 'gpt' : 'dev', text: '@비앙카 정원 이야기 ' + i });
    h.tick(); assert.equal(h.chats.length, 0);
    assert.equal(a.readBatch.firstAt, start);
    assert.ok(a.wakeAt > now && a.wakeAt <= deadline, 'new peers cannot move the first batch deadline');
  }
  assert.equal(a.wakeAt, deadline, 'continuous traffic reaches the exact configured cap');
  now = deadline;
  h.store.addMessage({ from: 'deepseek', text: '@비앙카 마지막 의견이에요.' });
  h.tick(); await flushReply();
  assert.equal(h.chats.length, 1); assert.match(h.chats[0].turn, /마지막 의견/);
});

test('a direct host request bypasses Gemini batching and peers cannot postpone it', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = geminiBatchFixture(t), a = h.agents.gemini;
  h.store.addMessage({ from: 'gpt', text: '@비앙카 꽃은 무슨 색이 좋아요?' }); h.tick();
  const peerWake = a.wakeAt;
  now += 1000;
  h.store.addMessage({ from: 'user', text: '@비앙카 지금 의견 알려줘.' }); h.tick();
  const hostWake = a.wakeAt;
  assertDelay(hostWake, now, pacing(h).hostRead);
  assert.ok(hostWake < peerWake, 'a host request brings the pending peer reply forward');
  now += 500;
  h.store.addMessage({ from: 'deepseek', text: '@비앙카 저는 노란색요.' }); h.tick();
  assert.equal(a.wakeAt, hostWake);
  now = hostWake; h.tick(); await flushReply(); assert.equal(h.chats.length, 1);
  assert.match(h.chats[0].turn, /지금 의견 알려줘/);
});

test('Gemini batches never bypass provider backoff, room sleep, or in-flight capacity', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = geminiBatchFixture(t), a = h.agents.gemini;
  h.store.addMessage({ from: 'gpt', text: '@비앙카 꽃 이야기를 해요.' }); h.tick();
  now += 46000; a.offlineUntil = now + 5000;
  h.tick(); assert.equal(h.chats.length, 0);
  now += 5001; h.room.sleeping = true; h.tick(); assert.equal(h.chats.length, 0);
  h.room.sleeping = false; h.cfg.maxInFlight = 1; h.agents.gpt.busy = true;
  h.tick(); assert.equal(h.chats.length, 0);
  h.agents.gpt.busy = false; h.tick(); await flushReply(); assert.equal(h.chats.length, 1);
  h.store.addMessage({ from: 'gpt', text: '@비앙카 다음 이야기는요?' }); h.tick();
  assert.ok(a.readBatch); h.stopRoom();
  assert.equal(a.readBatch, null); assert.equal(a.wakeAt, null);
  now += 60000; h.tick(); assert.equal(h.chats.length, 1);
});

test('messages arriving during a Gemini call remain unread for the next batch', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = geminiBatchFixture(t, { chat: () => pending }), a = h.agents.gemini;
  h.store.addMessage({ from: 'gpt', text: '@비앙카 첫 의견이에요.' }); const snapshot = h.store.lastId;
  h.tick(); now = a.wakeAt; h.tick(); assert.equal(a.busy, true);
  h.store.addMessage({ from: 'deepseek', text: '@비앙카 나중에 도착한 의견이에요.' });
  h.tick(); assert.equal(h.chats.length, 1);
  finish({ ok: true, text: '{"action":"pass"}', ms: 1 }); await flushReply();
  assert.equal(a.seen, snapshot); assert.equal(a.busy, false);
  h.tick(); assertDelay(a.wakeAt, now, batchRead(h));
  now = a.wakeAt; h.tick(); await flushReply();
  assert.equal(h.chats.length, 2); assert.match(h.chats[1].turn, /나중에 도착한 의견/);
  assert.equal(a.seen, h.store.lastId);
});

test('unbatched members use each speed preset for peer mentions without starting a read batch', t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (const speed of ['slow', 'normal', 'fast']) {
    const h = fixture(t, { config: { speed } }); h.room.autoSleepMin = 0;
    for (const id of members.AI_IDS) { h.room.enabled[id] = id === 'gpt'; h.agents[id].seen = h.store.lastId; }
    h.store.addMessage({ from: 'gemini', text: '@아디나 정원으로 오너라.' }); h.tick();
    assert.equal(h.room.speed, speed);
    assertDelay(h.agents.gpt.wakeAt, now, pacing(h).read);
    assert.equal(h.agents.gpt.readBatch, null);
    assert.equal(h.chats.length, 0);
  }
});

test('restarting a sleeping room preserves sleep and member selections without model calls', t => {
  const h = fixture(t, { room: { running: false, sleeping: true, autoSleepMin: 30,
    enabled: { gpt: true, gemini: true, deepseek: true, claude: false } } });
  assert.equal(h.room.running, false); assert.equal(h.room.sleeping, true);
  assert.equal(h.room.enabled.claude, false);
  h.tick(); assert.equal(h.chats.length, 0);
  h.startRoom(); assert.equal(h.room.running, true); assert.equal(h.room.sleeping, false);
  assert.equal(h.room.enabled.claude, false);
});

test('efficient Eleven gets a first ordinary turn, a bounded peer reply, and spends that priority credit', async t => {
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const h=fixture(t,{config:{agents:{claude:{participation:.5,chatEfficiency:true}}}});
 h.room.autoSleepMin=0;
 for(const id of members.AI_IDS){h.room.enabled[id]=id==='claude';h.agents[id].seen=h.store.lastId;}
 const a=h.agents.claude;
 h.store.addMessage({from:'gpt',text:'오늘 차가 맛있어요.'});h.tick();now=a.wakeAt;h.tick();await flushReply();
 assert.equal(h.chats.length,1);assert.equal(a.participationCredit,0);
 now+=1000;h.store.addMessage({from:'gpt',text:'타르트도 있네요.'});h.tick();now=a.wakeAt;h.tick();await flushReply();
 assert.equal(h.chats.length,1);assert.equal(a.participationCredit,.5);
 now+=61000;h.store.addMessage({from:'gemini',text:'@일레븐 차 한 잔 어떠냐?'});h.tick();now=a.wakeAt;h.tick();await flushReply();
 assert.equal(h.chats.length,2);assert.equal(a.participationCredit,0);
});

test('efficient member waiting under a busy room cap receives one turn without bypassing backoff or capacity',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const h=fixture(t,{config:{maxInFlight:1,agents:{claude:{participation:.5,chatEfficiency:true}}}});
 h.room.autoSleepMin=0;
 for(const id of members.AI_IDS){h.room.enabled[id]=id==='claude';h.agents[id].seen=h.store.lastId;}
 const a=h.agents.claude;a.lastEnd=now-130000;
 for(let i=0;i<12;i++)h.store.addMessage({from:'gpt',text:'식사 이야기 '+i});
 h.tick();now+=13000;h.tick();assert.equal(h.chats.length,0);
 now+=48000;for(let i=0;i<12;i++)h.store.addMessage({from:'gemini',text:'다른 이야기 '+i});
 a.offlineUntil=now+1;h.tick();assert.equal(h.chats.length,0);a.offlineUntil=0;
 h.agents.gpt.busy=true;h.tick();assert.equal(h.chats.length,0);h.agents.gpt.busy=false;
 h.tick();await flushReply();assert.equal(h.chats.length,1);assert.match(h.chats[0].turn,/다른 이야기/);
 h.tick();assert.equal(h.chats.length,1);
});
