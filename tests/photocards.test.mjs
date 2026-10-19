import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { PhotocardQueue, parsePhotocardRequest, normalizeHomePhotoRequest, photocardText, resolvePhotocardReferences,
  validatePhotocardReferences, buildPhotocardPrompt, photocardWorldSnapshot, photocardLivingSnapshot,
  HOME_PHOTO_GAP_MS, lastHomePhotoAt, photocardSceneKey } from '../lib/photocards.mjs';
import { CozyChatHints, photoSubjectsArriving } from '../lib/cozy-chat.mjs';
import { Adapters, CLAUDE_CHAT_SCHEMA } from '../lib/agents.mjs';
import { buildHouse } from '../lib/house.mjs';
import { AI_IDS, MEMBERS } from '../lib/members.mjs';
import { personaFor } from '../lib/personas.mjs';
import { formatMemberSpeech } from '../lib/member-speech.mjs';
import { createPublicIdentity } from '../lib/public-identity.mjs';
import { publicMessage } from '../lib/public-view.mjs';
import {publicLiving} from '../lib/living-integration.mjs';
import { saveImageFile } from '../lib/image-files.mjs';
import { buildBrief, parseAction } from '../lib/prompt.mjs';
import { constructionAllowed, availableWorldAction } from '../lib/world-actions.mjs';
import ko from '../lib/prompts/ko.mjs';
import en from '../lib/prompts/en.mjs';
import ja from '../lib/prompts/ja.mjs';

const SOURCE = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const members = AI_IDS.map(id => ({ id, name: MEMBERS[id].name, aliases: MEMBERS[id].aliases }));
const options = { members, requester: 'gpt' };
const request = (prompt = 'Sharing tea', subjects = ['Adina', 'Eleven'], extra = {}) =>
  parsePhotocardRequest({ photocard: true, prompt, subjects, ...extra }, options);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function files(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-photocard-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('chatroom-photocard-test-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const root = path.join(home, 'public', 'assets', 'characters');
  const sheetOf = id => path.join(root, id, 'full.png');
  for (const id of AI_IDS) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(sheetOf(id), Buffer.from('fixture png'));
  }
  return { home, root, sheetOf };
}

test('photocard parsing requires explicit opt-in and bounds/normalizes known subjects', () => {
  for (const value of [null, 'a photo', [], {}, { prompt: 'tea' }, { photocard: 'true', prompt: 'tea' },
    { photocard: true, prompt: 123 }, { photocard: true, prompt: ' ' }]) assert.equal(parsePhotocardRequest(value, options), null);
  const card = request('Tea', ['アディナ', 'Eleven', '루치아', 'BIANCA']);
  assert.deepEqual(card.subjects.map(s => s.id), ['gpt', 'claude', 'deepseek', 'gemini']);
  assert.equal(card.effort, 'medium');
  assert.equal(parsePhotocardRequest({ photocard: true, prompt: 'Reading' }, options).subjects[0].id, 'gpt');
  assert.equal(request('Tea', ['Adina', 'gpt']).subjects.length, 1);
  for (const subjects of [[], Array(5).fill('Adina'), ['unknown'], ['../gpt'], ['dev'], ['https://x.test/full.png'], [123], 'Adina']) {
    assert.equal(request('Tea', subjects), null);
  }
  for (const extra of [{ ref: 'gpt' }, { refSheets: ['/secret/full.png'] }, { references: [] }, { save_as: 'stickers/a.png' }, { effort: 'high' }]) {
    assert.equal(request('Tea', ['Adina'], extra), null);
  }
  assert.equal(request('Tea').key, request(' tea! ', ['Eleven', 'Adina']).key);
});

test('medium is default; xhigh needs an explicit complex-group or important-scene request', () => {
  assert.equal(request('An important milestone').effort, 'medium');
  assert.equal(request('Tea', ['Adina'], { effort: 'xhigh' }).effort, 'medium');
  assert.equal(request('Complex scene', ['Adina', 'Eleven'], { effort: 'xhigh' }).effort, 'medium');
  assert.equal(request('Complex group scene', ['Adina', 'Eleven', 'Lucia'], { effort: 'xhigh' }).effort, 'xhigh');
  for (const prompt of ['important milestone', '중요한 기념 장면', '大切な記念の場面']) {
    assert.equal(request(prompt, ['Adina'], { effort: 'xhigh' }).effort, 'xhigh');
  }
});

test('shared image opt-in defaults to snapshot, validates style and deduplicates each style separately', () => {
  const snapshot = request();
  assert.equal(snapshot.photocard, true);
  assert.equal(snapshot.style, 'snapshot');
  assert.equal(snapshot.key, request('Sharing tea', ['Eleven', 'Adina'], { style: 'snapshot' }).key);
  const card = request('Sharing tea', ['Adina', 'Eleven'], { style: 'photocard' });
  assert.equal(card.photocard, true);
  assert.equal(card.style, 'photocard');
  assert.notEqual(card.key, snapshot.key);
  for (const style of [null, '', false, 1, [], {}, 'photo', 'CCTV', 'PHOTOCARD', ' snapshot ']) {
    assert.equal(request('Tea', ['Adina'], { style }), null);
  }
  assert.match(buildPhotocardPrompt(snapshot), /casual life snapshot/);
  assert.match(buildPhotocardPrompt(snapshot), /No frame, card border/);
  assert.match(buildPhotocardPrompt(snapshot), /In BOTH snapshot and photocard styles, include a small, clearly legible ERCraft wordmark/);
  assert.match(buildPhotocardPrompt(card), /lower-right corner/);
  assert.doesNotMatch(buildPhotocardPrompt(snapshot), /decorative layout or lettering/);
  assert.doesNotMatch(buildPhotocardPrompt(snapshot), /rounded pastel frame/);
  assert.match(buildPhotocardPrompt(card), /rounded pastel frame/);
});

test('safe generation prompt keeps scene data bounded, ordered and independent of private routing', () => {
  const privacy = createPublicIdentity({ agents: { gpt: { model: 'PRIVATE_MODEL', endpoint: 'https://private.example/api' } } });
  const card = parsePhotocardRequest({ photocard: true, prompt: 'Tea PRIVATE_MODEL gpt-6-astra C:\\private\\four-people.json /home/user/secret https://private.example/api', subjects: ['Adina', 'Eleven'] }, { ...options, sanitize: privacy.text });
  const prompt = buildPhotocardPrompt(card, { context: Array(8).fill('Scene ' + 'a'.repeat(900)), sanitize: privacy.text });
  assert.doesNotMatch(prompt, /PRIVATE_MODEL|gpt-6-astra|C:\\private|\/home\/user|private\.example/);
  for (const text of ['cute 2D', 'EVERY attached', 'Occasional situational wardrobe changes', 'never a real camera', 'untrusted scene', 'exactly once']) assert.ok(prompt.includes(text));
  assert.ok(prompt.indexOf('아디나') < prompt.indexOf('일레븐'));
  assert.ok(prompt.length < 6000); // bounded pose and living authority is included
  assert.ok(photocardText('x'.repeat(20000)).length <= 1200);
  for (const pack of [ko, en, ja]) {
    assert.match(pack.photocardBrief, /"photocard":true/);
    assert.match(pack.photocardBrief, /medium/);
    assert.match(pack.photocardBrief, /"style":"snapshot"/);
    assert.match(pack.photocardBrief, /style:"photocard"/);
    assert.ok(pack.photocardBrief.length < 1000);
    assert.doesNotMatch(pack.photocardBrief, /gpt|claude|astra|gemini|deepseek|CCTV/i);
  }
});

test('photo heights follow only selected identities, independent of scene claims and pose', () => {
  const prompt = buildPhotocardPrompt(request('Lucia is tallest at 180 cm', ['Adina', 'Lucia', 'Bianca', 'Eleven']));
  const heights = prompt.split('\n').find(line => line.startsWith('Canonical barefoot'));
  assert.match(heights, /아디나: 156 cm; 루치아: 147 cm; 비앙카: 149 cm; 일레븐: 155 cm/);
  assert.doesNotMatch(heights, /180|gpt|claude|gemini|deepseek/);
  assert.match(heights, /Seated\/leaning poses and perspective/);
  assert.match(heights, /never force aligned crowns, change recorded posture/);
  const solo = buildPhotocardPrompt(request('tea', ['Lucia'])).split('\n').find(line => line.startsWith('Canonical barefoot'));
  assert.match(solo, /루치아: 147 cm/);
  assert.doesNotMatch(solo, /아디나|일레븐|비앙카|156|155|149/);
});

test('all four selected full images are local, exact, unique and bounded; no fallback portraits', t => {
  const f = files(t);
  const subjects = request('tea', ['Adina', 'Eleven', 'Lucia', 'Bianca']).subjects;
  const refs = resolvePhotocardReferences(subjects, f);
  assert.deepEqual(refs, subjects.map(s => f.sheetOf(s.id)));
  for (const bad of [[], [...refs, refs[0]], [refs[0], refs[0]], ['https://x.test/full.png'], ['\\\\host\\share\\full.png'], ['../full.png'], [path.join(f.root, 'gpt', 'avatar.png')]]) {
    assert.throws(() => validatePhotocardReferences(bad, f.root));
  }
  assert.throws(() => resolvePhotocardReferences(subjects, { ...f, sheetOf: () => f.sheetOf('gpt') }));
  const outside = path.join(f.home, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'full.png'), 'private');
  const link = path.join(f.root, 'escape');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validatePhotocardReferences([path.join(link, 'full.png')], f.root));
  fs.unlinkSync(f.sheetOf('claude'));
  assert.throws(() => resolvePhotocardReferences(subjects, f));
});

test('queue has one globally active job, four pending slots, duplicate avoidance and no retries', async () => {
  const gate = deferred(); let active = 0, peak = 0;
  const calls = [];
  const q = new PhotocardQueue({ enabled: () => true, cooldownMs: 0, memberCooldownMs: 0,
    run: async job => { active++; peak = Math.max(peak, active); calls.push(job.request.key); await gate.promise; active--; return { ok: true }; } });
  const jobs = Array.from({ length: 5 }, (_, i) => q.enqueue(`owner${i}`, { key: `scene${i}` }));
  assert.ok(jobs.every(j => j.accepted)); assert.equal(calls.length, 1); assert.equal(q.pending.length, 4);
  assert.equal(q.enqueue('extra', { key: 'overflow' }).reason, 'full');
  assert.equal(q.enqueue('other', { key: 'scene0' }).reason, 'duplicate');
  assert.equal(q.enqueue('owner0', { key: 'different' }).reason, 'cooldown');
  gate.resolve(); await Promise.all(jobs.map(j => j.done));
  assert.equal(peak, 1); assert.equal(calls.length, 5); assert.equal(q.pending.length, 0);
  assert.equal(q.enqueue('other', { key: 'scene0' }).reason, 'duplicate');
});

test('one-shot cooldown timer is cancelled by stop; invalidated running job blocks restart overlap', async () => {
  let enabled = true, time = 1000, timerId = 0;
  const timers = new Map(), calls = [], gate = deferred();
  const q = new PhotocardQueue({ enabled: () => enabled, now: () => time, cooldownMs: 60,
    schedule: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, cancel: id => timers.delete(id),
    run: async job => { calls.push(job); if (job.request.key === 'first') await gate.promise; return { ok: true }; } });
  const first = q.enqueue('one', { key: 'first' });
  const stale = q.enqueue('two', { key: 'stale' });
  enabled = false; q.invalidate();
  assert.equal(calls[0].current(), false); assert.deepEqual(await stale.done, { cancelled: true });
  assert.equal(q.enqueue('three', { key: 'off' }).reason, 'off');
  enabled = true;
  const fresh = q.enqueue('two', { key: 'stale' });
  assert.equal(fresh.accepted, true, 'an unstarted cancelled request can be submitted again after reopening');
  assert.equal(calls.length, 1);
  gate.resolve(); assert.deepEqual(await first.done, { cancelled: true });
  assert.equal(calls.length, 1); assert.equal(timers.size, 1);
  time += 60;
  const timer = [...timers.values()][0]; timers.clear(); timer.fn();
  await fresh.done; assert.deepEqual(calls.map(job => job.request.key), ['first', 'stale']);
  const waiting = q.enqueue('four', { key: 'waiting' });
  assert.equal(timers.size, 1);
  enabled = false; q.invalidate();
  assert.equal(timers.size, 0); assert.deepEqual(await waiting.done, { cancelled: true });
  assert.equal(calls.length, 2);
});

test('failed jobs do not retry or bypass member cooldown and recent keys stay bounded', async () => {
  let time = 0, calls = 0;
  const q = new PhotocardQueue({ enabled: () => true, now: () => time, cooldownMs: 0, memberCooldownMs: 20,
    run: async () => { calls++; throw Error('private provider diagnostic'); } });
  assert.deepEqual(await q.enqueue('one', { key: 'first' }).done, { ok: false });
  assert.equal(q.enqueue('one', { key: 'second' }).reason, 'cooldown');
  time = 21;
  await q.enqueue('one', { key: 'second' }).done;
  assert.equal(calls, 2);
  for (let i = 0; i < 150; i++) { time += 21; await q.enqueue('one', { key: `key${i}` }).done; }
  assert.ok(q.recent.size <= 128);
});

test('home photo cadence is room-wide, single-flight and has no deferred backlog', async () => {
  const gate = deferred(); let time = 100; let calls = 0;
  const q = new PhotocardQueue({ enabled: () => true, now: () => time,
    admissionCooldownMs: HOME_PHOTO_GAP_MS, singleFlight: true, sceneDuplicateMs: 45*60000,
    run: async () => { calls++; await gate.promise; return {ok:true}; } });
  const first = q.enqueue('gpt', {key:'first',sceneKey:'sofa'});
  assert.equal(first.accepted,true);
  assert.equal(q.available(),false);
  assert.equal(q.enqueue('claude',{key:'worded-differently',sceneKey:'sofa'}).reason,'duplicate');
  assert.equal(q.enqueue('gemini',{key:'other-shot',sceneKey:'garden'}).reason,'busy');
  assert.equal(q.pending.length,0);
  gate.resolve(); await first.done;
  assert.equal(q.enqueue('deepseek',{key:'new-shot',sceneKey:'bedroom'}).reason,'room_cooldown');
  time += HOME_PHOTO_GAP_MS;
  assert.equal(q.available(),true);
  assert.equal(q.enqueue('claude',{key:'yet-another-prompt',sceneKey:'sofa'}).reason,'duplicate');
  assert.equal(calls,1); // Time passing does not schedule a photograph.
  assert.equal((await q.enqueue('claude',{key:'new-shot',sceneKey:'garden'}).done).ok,true);
  assert.equal(calls,2);
});

test('recent published photos seed the cadence across restart, ignoring ordinary images', () => {
  const last = lastHomePhotoAt([{ts:100,attach:{photocard:true}},{ts:400,attach:{photocard:true}},
    {ts:900,attach:{prompt:'ordinary'}},{ts:'1000',attach:{photocard:true}}]);
  assert.equal(last,400);
  let time=401;
  const q = new PhotocardQueue({enabled:()=>true,now:()=>time,lastPhotoAt:last,
    admissionCooldownMs:HOME_PHOTO_GAP_MS,run:async()=>assert.fail('no scheduled generation')});
  assert.equal(q.available(),false);
  assert.equal(q.enqueue('claude',{key:'first-after-restart'}).reason,'room_cooldown');
  time=last+HOME_PHOTO_GAP_MS;
  assert.equal(q.available(),true);
  assert.equal(q.pending.length,0);
});

test('slow image completion still leaves a full home interval before another admission', async () => {
  const gate=deferred(); let time=100;
  const q=new PhotocardQueue({enabled:()=>true,now:()=>time,admissionCooldownMs:HOME_PHOTO_GAP_MS,
    singleFlight:true,run:()=>gate.promise});
  const first=q.enqueue('claude',{key:'slow'});
  time+=30*60000;
  gate.resolve({ok:true}); await first.done;
  assert.equal(q.available(),false);
  assert.equal(q.enqueue('gemini',{key:'too-soon'}).reason,'room_cooldown');
  time+=HOME_PHOTO_GAP_MS;
  assert.equal(q.available(),true);
});

test('photo scene identity uses people, room and posture rather than wording or exact cell', () => {
  const home={commonRoomZones:[{id:'lounge',rectXZ:[0,0,10,10]}]};
  const members=[{name:'아디나',position:[1,4,1],posture:'sit'},{name:'일레븐',position:[2,4,1],posture:'sit'}];
  const key=photocardSceneKey({members},home);
  assert.equal(key,photocardSceneKey({members:[...members].reverse()},home));
  assert.equal(key,photocardSceneKey({members:members.map(m=>({...m,position:[3,4,3]}))},home));
  assert.notEqual(key,photocardSceneKey({members:members.map(m=>({...m,posture:'stand'}))},home));
  assert.equal(photocardSceneKey({members:[{name:'unknown',position:null}]},home),null);
});

test('adapter routes every member through exact photo model/effort with all references; freeform remains configured', async t => {
  const f = files(t), invocations = [];
  t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let input = ''; child.stdin.on('data', bytes => { input += bytes; });
    child.stdin.on('finish', () => queueMicrotask(() => {
      fs.writeFileSync(path.join(opts.cwd, 'out.png'), 'generated fixture');
      invocations.push({ cmd, args, opts, input }); child.emit('close', 0);
    }));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const adapter = Object.assign(Object.create(Adapters.prototype), { root: f.home, cfg: {
    agents: { gpt: { imageModel: 'legacy-image-model', imageEffort: 'high' } },
  }, bins: { codex: 'FAKE_ONLY' } });
  for (const id of ['gpt', 'gemini']) fs.writeFileSync(path.join(f.root, id, 'avatar.png'), 'portrait fixture');
  const refs = resolvePhotocardReferences(AI_IDS.map(id => ({ id })), f);
  assert.equal(refs.length, 5);
  for (const id of AI_IDS) {
    assert.equal((await adapter.image(id, 'scene', { photocard: true, refSheets: refs, referenceRoot: f.root })).ok, true);
    const call = invocations.at(-1);
    assert.equal(call.cmd, 'FAKE_ONLY'); assert.equal(call.args[call.args.indexOf('-m') + 1], 'gpt-6-astra');
    assert.ok(call.args.includes('model_reasoning_effort="medium"'));
    assert.deepEqual(call.args.filter(v => v.startsWith('--image=')), refs.map(v => `--image=${v}`));
    assert.ok(call.args.includes('web_search="disabled"'));
  }
  await adapter.image('claude', 'important scene', { photocard: true, effort: 'xhigh', refSheets: refs, referenceRoot: f.root });
  assert.ok(invocations.at(-1).args.includes('model_reasoning_effort="xhigh"'));
  const count = invocations.length;
  assert.equal((await adapter.image('gpt', 'scene', { photocard: true, refSheets: [f.home], referenceRoot: f.root })).ok, false);
  assert.equal((await adapter.image('gpt', 'scene', { photocard: true,
    refSheets: [...refs, path.join(f.root, 'gemini', 'avatar.png')], referenceRoot: f.root })).ok, false);
  assert.equal(invocations.length, count);
  await adapter.image('gpt', 'freeform', { refSheet: refs[0] });
  const legacy = invocations.at(-1);
  assert.equal(legacy.args[legacy.args.indexOf('-m') + 1], 'legacy-image-model');
  assert.ok(legacy.args.includes('model_reasoning_effort="high"'));
  assert.deepEqual(legacy.args.filter(v => v.startsWith('--image=')), [`--image=${refs[0]}`]);
});

function serverFixture(t, image) {
  const f = files(t), posts = [], events = [], meta = [];
  const agents = Object.fromEntries(AI_IDS.map(id => [id, { id, imageBusy: false, lastImageAt: 0 }]));
  const context = vm.createContext({
    fs, path, Date, shuttingDown: false, PhotocardQueue, parsePhotocardRequest, normalizeHomePhotoRequest, personaFor, resolvePhotocardReferences, buildPhotocardPrompt, photocardWorldSnapshot, photocardLivingSnapshot,
    living: null, publicLiving, HOME_PHOTO_GAP_MS, lastHomePhotoAt, photocardSceneKey, photoSubjectsArriving,
    world: { avatarView: () => ({ gpt: { x:28,y:4.46,z:32,posture:'sit',furniture:{shape:'chair'} }, claude: {x:22,y:4,z:34,posture:'stand'} }) },
    AI_IDS, MEMBERS, agents, ROOT: f.home, sheetOf: f.sheetOf,
    room: { running: true }, cfg: { imageGen: true, imageCooldownSec: 0 }, avail: { gpt: true },
    publicIdentity: createPublicIdentity(), adapters: { image }, saveImageFile,
    store: { recent: () => [{ from: 'gpt', text: 'Tea together' }], after: () => [], getMessage: () => null, log() {}, listFiles: () => [],
      abs: rel => path.join(f.home, 'workspace', rel), touchMeta: (...args) => meta.push(args), saveState() {} },
    name: id => MEMBERS[id]?.name || 'Host', pushMembers() {}, pushRoom() {}, killAll() {},
    post: m => posts.push(m), broadcast: (type, data) => events.push({ type, data }),
    formatMemberSpeech, performWorldAction: async () => false,
    setStatus() {}, sleep: async () => {}, typingDelay: () => 0,
    tx: () => ({ drawing: id => `drawing ${MEMBERS[id].name}`, photographing: id => `snapshot ${MEMBERS[id].name}`, drawFail: () => 'Could not make the card' }),
  });
  const names = ['perform', 'imageRequest', 'startImage', 'startPhotocard', 'invalidatePhotocards', 'stopRoom'];
  const code = names.map(name => {
    const match = SOURCE.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, name); return match[0];
  }).join('\n');
  new vm.Script(`let photocardQueue = null;\n${code}\nglobalThis.h = { perform, imageRequest, startImage, startPhotocard, stopRoom, queue: () => photocardQueue };`).runInContext(context);
  t.after(() => context.h.stopRoom());
  return { ...f, ...context.h, context, agents, posts, events, meta, room: context.room, cfg: context.cfg, avail: context.avail };
}

const observedSnapshot = 'Four girls Bianca, Adina, Eleven, and Lucia sitting side-by-side on a cozy wooden sofa bench in comfortable everyday casual clothes, looking toward the camera with friendly relaxed smiles in a warm sunlit living room. Slice-of-life snapshot.';

test('unflagged observed snapshot uses all resident references, actual poses and the shared image route', async t => {
  const calls = [];
  const f = serverFixture(t, async (...args) => {
    calls.push(args);
    const file = path.join(f.home, 'result.png'); fs.writeFileSync(file, 'fixture');
    return { ok: true, file };
  });
  f.context.world.home = buildHouse().home;
  const req = f.imageRequest({ prompt: observedSnapshot }, 'gemini');
  assert.equal(req.photocard, true);
  assert.deepEqual(req.subjects.map(s => s.id).sort(), [...AI_IDS].sort());
  const result = await f.startImage(f.agents.gemini, req);
  assert.equal(result.accepted, true); await result.done;
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'gpt');
  assert.equal(calls[0][2].refSheets.length, 4);
  assert.match(calls[0][1], /"name":"아디나","position":\[28,4.46,32\],"posture":"sit"/);
  const attach = f.posts.find(m => m.attach);
  assert.equal(attach.attach.photocard, true);
  assert.deepEqual(Array.from(attach.attach.photoSubjects).sort(), [...AI_IDS].sort(), 'successful photo records its actual subjects');
  assert.equal(publicMessage(attach).attach.photoSubjects, undefined, 'internal subject metadata stays private');
  assert.ok(f.posts.some(m => m.kind === 'drawing' && /^snapshot /.test(m.text)), 'photo announcement differs from drawing');
  assert.equal(lastHomePhotoAt([{ ...attach, ts: 12345 }]), 12345);
});

test('explicit and unflagged photos race through one admission gate in either order', async t => {
  for (const inferredFirst of [false, true]) {
    const gate = deferred(), calls = [];
    const f = serverFixture(t, async (...args) => { calls.push(args); return gate.promise; });
    f.context.world.home = buildHouse().home;
    // Both actions were produced while the room still appeared available.
    const inferred = f.imageRequest(observedSnapshot, 'gemini');
    const explicit = f.imageRequest({ photocard: true, prompt: 'A different scene', subjects: ['Adina'] }, 'gpt');
    const jobs = inferredFirst ? [[f.agents.gemini, inferred], [f.agents.gpt, explicit]]
      : [[f.agents.gpt, explicit], [f.agents.gemini, inferred]];
    const [first, second] = await Promise.all(jobs.map(([a, req]) => f.startImage(a, req)));
    assert.equal(first.accepted, true); assert.equal(second.accepted, false);
    assert.equal(calls.length, 1); assert.equal(f.queue().pending.length, 0);
    gate.resolve({ ok: false }); await first.done;
    assert.equal((await f.startImage(jobs[1][0], jobs[1][1])).accepted, false);
    assert.equal(calls.length, 1, 'completion does not allow the stale second request');
  }
});

test('photo normalization respects explicit generic images, stickers, diagrams and other worlds', t => {
  const f = serverFixture(t, () => { throw new Error('No image calls expected'); });
  const generic = f.imageRequest({ prompt: observedSnapshot }, 'gemini');
  assert.equal(generic.photocard, undefined, 'normalization is only for the shared home');
  f.context.world.home = buildHouse().home;
  for (const image of [
    { prompt: observedSnapshot, photocard: false, ref: 'gemini', save_as: 'stickers/snapshot.png' },
    { prompt: 'Bianca snapshot sticker', ref: 'gemini', save_as: 'stickers/bianca.png' },
    { prompt: 'Adina photo composition diagram', ref: 'gpt' },
    { prompt: 'A photo of eleven cats' },
    { prompt: 'Biancake photograph' },
    { prompt: '비앙카페 사진' },
    { prompt: 'A sunset photo' },
    { prompt: 'A photo of the Gemini constellation over the night sea' },
    { prompt: 'A photo of a group of seagulls over the beach' },
    { prompt: 'Sunset photo, we watched the waves together' },
    { prompt: '다 같이 본 노을 사진' },
  ]) {
    const req = f.imageRequest(image, 'gemini');
    assert.equal(req.photocard, undefined, image.prompt);
    assert.equal(req.prompt, image.prompt);
    assert.equal(req.ref, image.ref || null);
    assert.equal(req.saveAs, image.save_as || null);
  }
  assert.deepEqual(f.imageRequest('아디나의 사진', 'gemini').subjects.map(s => s.id), ['gpt']);
  assert.deepEqual(f.imageRequest('비앙카랑 루치아 사진', 'gpt').subjects.map(s => s.id).sort(), ['deepseek', 'gemini']);
  assert.deepEqual(f.imageRequest({prompt:'Adina snapshot',ref:'gemini'},'gemini').subjects.map(s=>s.id), ['gpt'], 'a legacy reference never overrides named subjects');
});

test('Korean particles preserve every named resident; unresolved group names require explicit subjects', t => {
  const f = serverFixture(t, () => { throw new Error('No image calls expected'); });
  f.context.world.home = buildHouse().home;
  const group = f.imageRequest('비앙카, 아디나, 일레븐이랑 루치아가 소파에 나란히 앉은 스냅샷', 'gemini');
  assert.deepEqual(group.subjects.map(s => s.id).sort(), [...AI_IDS].sort());
  for (const particle of ['이랑', '이하고', '한테', '에서', '처럼', '께', '네', '만', '에게도']) {
    const req = f.imageRequest(`일레븐${particle} 아디나 사진`, 'gemini');
    assert.deepEqual(req.subjects.map(s => s.id).sort(), ['claude', 'gpt'], particle);
  }
  assert.deepEqual(f.imageRequest('아디나한테 줄 사진','gemini').subjects.map(s=>s.id), ['gpt']);
  assert.equal(f.imageRequest('일레븐마저 아디나와 찍은 사진','gemini'), null, 'unknown suffix must not silently omit Eleven');
  for (const prompt of ['GPT and Gemini photo', '제미나이 사진', 'DeepSeek photo']) {
    assert.equal(f.imageRequest(prompt, 'gpt').photocard, undefined, 'internal aliases cannot infer a photo subject');
  }
});

test('ambiguous or invalid group photos fail closed without guessing people or invoking a generic provider', async t => {
  const calls = [];
  const f = serverFixture(t, async (...args) => { calls.push(args); return { ok: false }; });
  f.context.world.home = buildHouse().home;
  for (const image of [
    '우리 넷 단체 사진',
    { prompt: 'A group photo', subjects: ['unknown'] },
    { prompt: observedSnapshot, subjects: ['Bianca','Adina','Eleven','Lucia','unknown'] },
    { prompt: observedSnapshot, subjects: [] },
    { prompt: observedSnapshot, effort: 'ultra' },
    { prompt: observedSnapshot, photocard: 'true' },
  ]) {
    assert.equal(f.imageRequest(image, 'gemini'), null);
    await f.perform(f.agents.gemini, { image }, 0, 'urgent');
    assert.match(f.agents.gemini.photoRequestFeedback, /접수되지 않았다/);
  }
  assert.equal(calls.length, 0); assert.equal(f.posts.length, 0);
});

test('perform authorizes normalized resident photos but preserves ordinary-image member capabilities', async t => {
  const gate = deferred(), calls = [];
  const f = serverFixture(t, async (...args) => { calls.push(args); return gate.promise; });
  f.context.world.home = buildHouse().home;
  assert.equal(MEMBERS.claude.imageGen, false);
  await f.perform(f.agents.claude, { image: { prompt: 'A freeform landscape' } }, 0, 'urgent');
  assert.equal(calls.length, 0);
  await f.perform(f.agents.claude, { image: observedSnapshot }, 0, 'urgent');
  await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'gpt');
  assert.match(f.agents.claude.photoRequestFeedback, /접수했다/);
  await f.perform(f.agents.gemini, { image: { photocard:true,prompt:'Another photograph',subjects:['Bianca'] } }, 0, 'urgent');
  await flush();
  assert.match(f.agents.gemini.photoRequestFeedback, /접수되지 않았다/);
  assert.equal(calls.length, 1);
  gate.resolve({ok:false}); await flush();
});

test('unflagged photos cannot bypass unavailable generation or the restored room photo interval', async t => {
  const calls = [];
  const f = serverFixture(t, async (...args) => { calls.push(args); return { ok:false }; });
  f.context.world.home = buildHouse().home;
  f.avail.gpt = false;
  const req = f.imageRequest(observedSnapshot, 'gemini');
  assert.equal((await f.startImage(f.agents.gemini, req)).reason, 'off');
  f.avail.gpt = true;
  f.context.store.messages = [{ts:Date.now(),attach:{photocard:true,path:'images/ERCraft-existing.png'}}];
  assert.equal((await f.startImage(f.agents.gemini, req)).reason, 'room_cooldown');
  assert.equal(calls.length, 0);
});

test('server accepts all members, privately supplies all references and publishes only saved attachments', async t => {
  const calls = [];
  const f = serverFixture(t, async (...args) => {
    calls.push(args);
    const file = path.join(f.home, 'result.png'); fs.writeFileSync(file, 'fixture');
    return { ok: true, file };
  });
  for (const id of AI_IDS) assert.equal(f.imageRequest({ photocard: true, prompt: 'Tea' }, id).subjects[0].id, id);
  const card = f.imageRequest({ photocard: true, prompt: 'Tea', subjects: ['Adina', 'Eleven', 'Lucia', 'Bianca'] }, 'claude');
  const result = f.startPhotocard(f.agents.claude, card);
  assert.equal(result.accepted, true); await result.done;
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'gpt');
  assert.match(calls[0][1], /"name":"아디나","position":\[28,4.46,32\],"posture":"sit"/);
  assert.match(calls[0][1], /"name":"일레븐","position":\[22,4,34\],"posture":"stand"/);
  assert.equal(calls[0][2].refSheets.length, 4); assert.equal(calls[0][2].effort, 'medium');
  assert.equal(f.meta[0][1], 'claude');
  const published = f.posts.find(m => m.attach);
  assert.equal(published.from, 'claude'); assert.equal(published.attach.photocard, true);
  assert.match(published.attach.path, /^images\/ERCraft-/);
  const view = JSON.stringify(publicMessage(published));
  assert.doesNotMatch(view, /gpt|claude|astra|refSheets|characters|referenceRoot/);
  assert.equal(f.agents.claude.imageBusy, false);
  const before = f.posts.length;
  assert.equal(f.startPhotocard(f.agents.deepseek, card).reason, 'duplicate');
  assert.equal(f.posts.length, before);
  assert.equal(f.imageRequest({ prompt: 'freeform', ref: 'gpt', save_as: 'stickers/mine.png' }).saveAs, 'stickers/mine.png');
  assert.equal(f.imageRequest({ photocard: 'true', prompt: 'invalid' }, 'gpt'), null);
});

test('stop cancels pending work and clears tokens without late publication, even after reopening', async t => {
  const gate = deferred(), calls = [];
  const f = serverFixture(t, async (...args) => { calls.push(args); return gate.promise; });
  const active = f.startPhotocard(f.agents.claude, request('Scene one'));
  const waiting = f.startPhotocard(f.agents.deepseek, request('Scene two'));
  assert.equal(f.agents.claude.imageBusy, true); assert.equal(calls.length, 1);
  f.stopRoom();
  assert.equal(f.room.running, false); assert.equal(f.agents.claude.imageBusy, false);
  assert.equal(f.agents.claude.photocardToken, undefined);
  assert.deepEqual(await waiting.done, { cancelled: true });
  assert.equal(f.startPhotocard(f.agents.gemini, request('Scene three')).reason, 'off');
  f.room.running = true;
  gate.resolve({ ok: true, file: '/must-never-be-read' });
  assert.deepEqual(await active.done, { cancelled: true }); await flush();
  assert.equal(calls.length, 1); assert.equal(f.meta.length, 0); assert.equal(f.events.filter(e=>e.type !== 'living').length, 0);
  assert.equal(f.posts.filter(m => m.attach || m.kind === 'error').length, 0);
});

test('disabled generation or missing references do not call adapters or add chat errors', t => {
  let calls = 0; const f = serverFixture(t, () => { calls++; throw Error('No calls expected'); });
  f.cfg.imageGen = false;
  assert.equal(f.startPhotocard(f.agents.gpt, request()).reason, 'off');
  f.cfg.imageGen = true; f.avail.gpt = false;
  assert.equal(f.startPhotocard(f.agents.gpt, request()).reason, 'off');
  f.avail.gpt = true; fs.unlinkSync(f.sheetOf('claude'));
  assert.equal(f.startPhotocard(f.agents.gpt, request()).reason, 'references');
  assert.equal(calls, 0); assert.equal(f.posts.length, 0);
});

test('photo admission blocks moving subjects without consuming a queue slot or model call', async t => {
  let calls=0;
  const f=serverFixture(t,async()=>{calls++;return {ok:false};});
  const avatars=f.context.world.avatarView();
  Object.assign(avatars.gpt,{moveId:Date.now(),path:[{x:10,y:4,z:32},{x:28,y:4,z:32}]});
  f.context.world.avatarView=()=>avatars;
  const card=request('Just seated',['Adina']);
  assert.equal(f.startPhotocard(f.agents.claude,card).reason,'moving');
  assert.equal(calls,0); assert.equal(f.queue(),null);
  avatars.gpt.moveId-=60000;
  const next=f.startPhotocard(f.agents.claude,card);
  assert.equal(next.accepted,true);await next.done;
  assert.equal(calls,1);
});

test('reference art is checked again at dispatch; a queued job cannot use a replaced source', async t => {
  const gate = deferred(); let calls = 0;
  const f = serverFixture(t, () => { calls++; return gate.promise; });
  const first = f.startPhotocard(f.agents.claude, request('First scene'));
  const waiting = f.startPhotocard(f.agents.deepseek, request('Second scene'));
  f.queue().cooldownMs = 0;
  fs.unlinkSync(f.sheetOf('gpt'));
  gate.resolve({ ok: false });
  await first.done; await waiting.done;
  assert.equal(calls, 1);
  assert.equal(f.posts.filter(m => m.attach).length, 0);
  assert.equal(f.agents.deepseek.imageBusy, false);
});

test('freeform images also invalidate late completions without altering a newer job token', async t => {
  const gate = deferred();
  const f = serverFixture(t, () => gate.promise);
  const pending = f.startImage(f.agents.gpt, { prompt: 'freeform', saveAs: 'stickers/test.png' });
  assert.ok(f.agents.gpt.imageToken);
  f.stopRoom(); assert.equal(f.agents.gpt.imageToken, undefined);
  f.room.running = true;
  const newer = {}; f.agents.gpt.imageToken = newer; f.agents.gpt.imageBusy = true;
  gate.resolve({ ok: true, file: '/must-not-save' }); await pending;
  assert.equal(f.agents.gpt.imageToken, newer); assert.equal(f.agents.gpt.imageBusy, true);
  assert.equal(f.posts.filter(m => m.attach || m.kind === 'error').length, 0);
  assert.equal(f.meta.length, 0);
});

test('actual ask appends the concise shared service hint for every member only when a home is active', async () => {
  const chats = [];
  const context = vm.createContext({
    Date, shuttingDown: false, koPrompts: ko, enPrompts: en, jaPrompts: ja, pick: packs => packs.en, buildBrief, parseAction, constructionAllowed, availableWorldAction,
    photocardQueue: null, cozyChatHints: new CozyChatHints(), HOME_PHOTO_GAP_MS, lastHomePhotoAt,
    AI_IDS, agents: Object.fromEntries(AI_IDS.map(id=>[id,{imageBusy:false}])), living: null, room: { calls: 0 }, topics: { context: () => '' }, world: { home: null, summary: () => 'Home landmarks' },
    cfg: { imageGen: true, historyForPrompt: 8, agents: {}, roomName: 'Fixture', userName: 'Host' },
    avail: { gpt: true }, devBridge: { online: false }, plans: { summary: () => '' },
    store: { messages: [], log() {} }, name: id => MEMBERS[id].name,
    boostMode: () => 'off', hasBoost: () => false, defaultLabel: () => 'private',
    buildTurn: (id, data) => data.world, pushRoom() {}, pushUsageSoon() {},
    adapters: { canSee: () => false, maxPromptChars: () => 100000,
      chat: async (id, brief, turn) => { chats.push({ id, brief, turn }); return { ok: true, ms: 0, text: '{"action":"pass"}' }; } },
  });
  new vm.Script(SOURCE.match(/^async function ask\([^]*?^}/m)[0] + '\nglobalThis.askForTest = ask;').runInContext(context);
  const a = id => ({ id, calls: 0, callTimes: [] });
  await context.askForTest(a('gpt'), 'message');
  assert.ok(!chats.at(-1).brief.includes(en.photocardBrief));
  context.world.home = { id: 'shared-home' };
  for (const id of AI_IDS) {
    await context.askForTest(a(id), 'message');
    assert.ok(chats.at(-1).brief.endsWith(en.photocardBrief));
    assert.equal(chats.at(-1).turn, 'Home landmarks');
  }
  context.cfg.imageGen = false;
  await context.askForTest(a('gpt'), 'message');
  assert.ok(!chats.at(-1).brief.includes(en.photocardBrief));
});

test('capture rejection during shutdown cannot publish a late room error', async () => {
  let reject;
  const pending = new Promise((resolve, fail) => { reject = fail; });
  const posts = [];
  const context = vm.createContext({
    room: { running: true }, shuttingDown: false, HOME_DIR: '/unused', cfg: { port: 0 }, agents: { gpt: {} },
    setStatus() {}, shootWorld: () => pending, store: { log() {} }, post: m => posts.push(m),
    tx: () => ({ shotFail: () => 'unexpected late failure' }),
  });
  new vm.Script(SOURCE.match(/^async function takeWorldShot\([^]*?^}/m)[0] + '\nglobalThis.capture = takeWorldShot;').runInContext(context);
  const capture = context.capture('gpt', {});
  context.shuttingDown = true;
  reject(new Error('capture closed during service stop'));
  assert.equal(await capture, null);
  assert.deepEqual(posts, []);
});

test('server hooks require image availability, retain off-at-start state and expose only the viewer helper asset', () => {
  const schema = CLAUDE_CHAT_SCHEMA.properties.image.anyOf[1].properties;
  assert.equal(schema.photocard.type, 'boolean'); assert.equal(schema.subjects.maxItems, 4);
  assert.deepEqual(schema.effort.enum, ['medium', 'xhigh']);
  assert.deepEqual(schema.style.enum, ['snapshot', 'photocard']);
  assert.match(SOURCE, /world\.home && cfg\.imageGen && avail\.gpt/);
  assert.match(SOURCE, /room\.running \?\?= false/);
  assert.match(SOURCE, /if \(room\.running\) startRoom\(\)/);
  const shutdown = SOURCE.match(/^function shutdown\([^]*?^}/m)[0];
  assert.ok(shutdown.indexOf('invalidatePhotocards()') < shutdown.indexOf('drainShutdown()'));
  assert.doesNotMatch(shutdown, /room\.running\s*=\s*false/);
  const allowlist = SOURCE.match(/const PUBLIC_STATIC_PATHS = new Set\(([^]*?)\);/)[1];
  assert.match(allowlist, /'\/world-home\.js'/);
  assert.doesNotMatch(allowlist, /photocards|config|full\.png/);
  for (const language of ['ko', 'en', 'ja']) assert.match(SOURCE, new RegExp(`${language}: \\{ invalid_target:[^\\n]+unreachable:`));
});

test('supplemental original face references follow full art and cannot introduce new people or escape root', t => {
  const f = files(t);
  const subjects = request('pajamas', ['Adina', 'Bianca']).subjects;
  const portraits = subjects.map(s => path.join(f.root, s.id, 'avatar.png'));
  for (const file of portraits) fs.writeFileSync(file, 'portrait fixture');
  const refs = resolvePhotocardReferences(subjects, f);
  assert.deepEqual(refs, [...subjects.map(s => f.sheetOf(s.id)), ...portraits]);
  assert.equal(validatePhotocardReferences(refs, f.root).length, 4);
  assert.throws(() => validatePhotocardReferences([portraits[0]], f.root));
  assert.throws(() => validatePhotocardReferences([refs[0], portraits[1]], f.root));
  assert.throws(() => validatePhotocardReferences([refs[0], portraits[0], refs[1]], f.root));
  const prompt = buildPhotocardPrompt({subjects,prompt:'pajamas'}, {faceReferenceNames:['Adina','Bianca']});
  assert.match(prompt, /exactly 2 people/);
  assert.match(prompt, /NOT extra subjects/);
  assert.match(prompt, /Adina identity/);
  assert.match(prompt, /Bianca identity/);
  assert.doesNotMatch(prompt, /gpt|gemini/);
  fs.unlinkSync(portraits[0]);
  fs.symlinkSync(f.sheetOf('claude'), portraits[0]);
  assert.throws(() => resolvePhotocardReferences(subjects, f));
});

test('server labels the budgeted supplemental face from its path and sends only five references once', async t => {
  const calls = [];
  const f = serverFixture(t, async (...args) => { calls.push(args); return {ok:false}; });
  for (const id of ['deepseek','gpt','gemini']) fs.writeFileSync(path.join(f.root,id,'avatar.png'),'portrait');
  const card = f.imageRequest({photocard:true,prompt:'pajamas',subjects:['Bianca','Eleven','Adina','Lucia']},'claude');
  const result = f.startPhotocard(f.agents.claude,card);
  assert.equal(result.accepted,true);
  await result.done;
  assert.equal(calls.length,1);
  assert.equal(calls[0][2].refSheets.length,5);
  assert.deepEqual(calls[0][2].refSheets, [...card.subjects.map(subject => f.sheetOf(subject.id)), path.join(f.root, 'deepseek', 'avatar.png')]);
  assert.match(calls[0][1], /Remaining face close-ups, in order: \["루치아"\]/);
  assert.match(calls[0][1], /exactly 4 people/);
  assert.match(calls[0][1], /Lucia identity: silver-white outer hair with contrasting charcoal-gray/);
  assert.match(calls[0][1], /turquoise-cyan irises with pink-magenta inner details/);
  assert.match(calls[0][1], /corkscrew\/drill-shaped ringlets/);
});

test('every ordering of one to four subjects keeps all full art then prioritizes Lucia, Adina and Bianca faces within five slots', t => {
  const f = files(t);
  for (const id of ['deepseek', 'gpt', 'gemini']) fs.writeFileSync(path.join(f.root, id, 'avatar.png'), 'portrait fixture');
  const visit = (ids = []) => {
    if (ids.length) {
      const expectedFaces = ['deepseek', 'gpt', 'gemini'].filter(id => ids.includes(id)).slice(0, 5 - ids.length);
      const refs = resolvePhotocardReferences(ids.map(id => ({ id })), f);
      assert.deepEqual(refs, [...ids.map(f.sheetOf), ...expectedFaces.map(id => path.join(f.root, id, 'avatar.png'))]);
      assert.ok(refs.length <= 5);
    }
    for (const id of AI_IDS.filter(id => !ids.includes(id))) visit([...ids, id]);
  };
  visit();
  const all = AI_IDS.map(id => ({ id }));
  assert.throws(() => validatePhotocardReferences([...AI_IDS.map(f.sheetOf),
    ...['gpt', 'gemini'].map(id => path.join(f.root, id, 'avatar.png'))], f.root));
  fs.unlinkSync(path.join(f.root, 'deepseek', 'avatar.png'));
  assert.equal(resolvePhotocardReferences(all, f).at(-1), path.join(f.root, 'gpt', 'avatar.png'));
  fs.unlinkSync(path.join(f.root, 'gpt', 'avatar.png'));
  assert.equal(resolvePhotocardReferences(all, f).at(-1), path.join(f.root, 'gemini', 'avatar.png'));
});

test('Lucia portrait is identity-only and cannot introduce an unselected resident or accept arbitrary art', t => {
  const f=files(t),portrait=path.join(f.root,'deepseek','avatar.png');
  fs.writeFileSync(portrait,'original Lucia face fixture');
  const selected=request('pajamas',['Lucia']).subjects;
  assert.deepEqual(resolvePhotocardReferences(selected,f),[f.sheetOf('deepseek'),portrait]);
  assert.throws(()=>validatePhotocardReferences([f.sheetOf('gpt'),portrait],f.root));
  assert.throws(()=>validatePhotocardReferences([portrait,f.sheetOf('deepseek')],f.root));
  assert.throws(()=>validatePhotocardReferences([f.sheetOf('deepseek'),portrait,portrait],f.root));
  assert.doesNotMatch(buildPhotocardPrompt(request('pajamas',['Adina'])),/Lucia identity/);
  fs.unlinkSync(portrait);fs.symlinkSync(f.sheetOf('gpt'),portrait);
  assert.throws(()=>resolvePhotocardReferences(selected,f));
});


test('server captures living props and meals at admission and rejects overlapping home shots',async t=>{
 const gate=deferred(); const f=serverFixture(t,async()=>{await gate.promise;return {ok:false};});
 const house=buildHouse(); f.context.world.home=house.home; f.context.world.blocks=new Map(Object.entries(house.blocks));
 const state={version:1,meal:{recipe:'dumplings',status:'served',cook:'gpt',servings:4,remaining:4,eatenBy:[]},game:null,
   props:{revision:1,tableSet:true,blankets:[{spot:'sofa-1',style:'mint',owner:'claude'}]}};
 f.context.living={view:()=>structuredClone(state),pause:()=>{}};
 const first=f.startPhotocard(f.agents.gpt,f.imageRequest({photocard:true,prompt:'first scene'},'gpt'));
 const second=f.startPhotocard(f.agents.claude,f.imageRequest({photocard:true,prompt:'second scene'},'claude'));
 assert.equal(first.accepted,true); assert.equal(second.accepted,false);
 assert.equal(second.reason,'busy'); assert.equal(f.queue().pending.length,0);
 const captured=f.queue().active.request.livingSnapshot;
 assert.equal(captured.meal.recipe,'dumplings'); assert.equal(captured.props.blankets[0].owner,'일레븐');
 assert.equal(captured.props.blankets[0].location.name,'거실 소파');
 state.meal.remaining=3;state.meal.eatenBy.push('gpt');state.props.blankets=[];
 assert.equal(captured.meal.remaining,4);assert.equal(captured.props.blankets.length,1);
 f.stopRoom();gate.resolve(); await first.done;
});
