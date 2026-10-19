import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PlanBook, DEFAULT_PLANNER_CFG, freshPlanLedger } from '../lib/plans.mjs';
import { World } from '../lib/world.mjs';

const IDS = ['claude', 'gpt', 'deepseek', 'gemini'];
const siteA = [0, 0, 13, 13], siteB = [16, 0, 29, 13];
const recipe = (site = siteA) => ({ kind: 'house', origin: [site[0] + 2, site[1] + 2], size: [7, 7], wallHeight: 3, front: 's',
  materials: { foundation: 'stone', wall: 'white', trim: 'log', floor: 'planks', roof: 'black', window: 'glass', accent: 'purple' },
  roof: { type: 'gable', ridge: 'x', overhang: 1 }, windows: { spacing: 3, height: 1, sill: 1 }, features: [] });
const req = (brief = '작은 집', site = siteA) => ({ title: brief, brief, ...(site ? { site } : {}) });
const jsonAnswer = (prompt) => ({ ok: true, text: JSON.stringify(recipe(JSON.parse(prompt.split('\n').at(-1)).site)), ms: 1 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, overrides = {}, planner = jsonAnswer) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chatroom-plan-test-'));
  fs.mkdirSync(path.join(home, 'data'));
  const world = new World(home, IDS);
  const cfg = { planner: { maxPerDay: 6, cooldownSec: 0, memberCooldownSec: 0, stageCooldownSec: 0, ...overrides } };
  const book = new PlanBook(home, cfg, world, planner);
  t.after(() => {
    clearTimeout(world.saveTimer);
    // The fixture owns this freshly created temporary directory only.
    assert.equal(path.dirname(home), os.tmpdir());
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, world, cfg, book, restart: () => new PlanBook(home, cfg, new World(home, IDS), planner) };
}

test('defaults allow 24 dispatches a day with 15s room and 60s member waits, retaining the 25s build pace', () => {
  assert.deepEqual(DEFAULT_PLANNER_CFG, { enabled: true, maxPerDay: 24, cooldownSec: 15, memberCooldownSec: 60, stageCooldownSec: 25, timeoutSec: 600 });
});

test('freshPlanLedger validates and copies quota attempts without carrying plans or unresolved attempts', (t) => {
  const attempts = [{ id: 'archived-design', by: 'deepseek', at: Date.now(), status: 'ok' }];
  const state = freshPlanLedger(attempts);
  assert.equal(state.version, 1);
  assert.deepEqual(state.plans, []);
  assert.equal(state.inflight, null);
  assert.equal(state.lastStageAt, null);
  assert.deepEqual(state.whim, { offeredAt: null, messageId: 0 });
  assert.deepEqual(state.attempts, attempts);
  assert.notEqual(state.attempts, attempts);
  assert.notEqual(state.attempts[0], attempts[0]);
  const f = fixture(t);
  fs.writeFileSync(f.book.file, JSON.stringify(state));
  assert.equal(f.restart().view().limits.used, 1);
  attempts[0].status = 'pending';
  assert.equal(state.attempts[0].status, 'ok');
  assert.throws(() => freshPlanLedger(attempts), /orphan attempt/);
  for (const invalid of [null, {}, [{ id: 'bad', by: 'user', at: 1, status: 'ok' }],
    [{ id: 'bad', by: 'gpt', at: -1, status: 'ok' }], [state.attempts[0], state.attempts[0]]]) {
    assert.throws(() => freshPlanLedger(invalid));
  }
  assert.deepEqual(freshPlanLedger().attempts, []);
});

test('request persists a bounded recipe without building; any member can stage it and replays are empty', async (t) => {
  let onCalls = 0, calls = 0, prompt;
  const f = fixture(t, {}, (p) => { prompt = p; calls++; assert.equal(onCalls, 1); return jsonAnswer(p); });
  const { plan } = await f.book.request(req(), 'claude', { onCall: () => onCalls++ });
  assert.equal(f.world.blocks.size, 0);
  assert.equal(plan.status, 'draft');
  assert.equal(plan.stages.length, 4);
  assert.equal(calls, 1);
  assert.ok(prompt.length < 24000);
  assert.ok(!prompt.includes('messages.jsonl'));
  assert.equal(f.book.view().limits.used, 1);
  for (let stage = 1; stage <= 4; stage++) {
    let result, chunks = 0;
    do {
      assert.ok(++chunks <= 8);
      result = f.book.execute({ id: plan.id, stage: 'next' }, IDS[stage - 1]);
      assert.ok(result.changes.length > 0 && result.changes.length <= 80);
      assert.equal(result.advanced, true);
    } while (result.plan.completedStages < stage);
    assert.equal(result.plan.completedStages, stage);
    assert.equal(result.complete, stage === 4);
    assert.equal(f.book.execute({ id: plan.id, stage }, 'gemini').changes.length, 0);
  }
  assert.equal(f.world.blocks.size, plan.count);
  assert.equal(f.restart().view().plans[0].status, 'complete');
  assert.throws(() => f.book.execute({ id: plan.id, stage: 5 }, 'gpt'));
  const exposed = JSON.stringify(f.book.view());
  for (const secret of ['gpt-6-astra', 'xhigh', 'expectedCells', 'stageChecksums', 'recipe', 'initialSnapshot']) assert.ok(!exposed.includes(secret));
});

test('all four owners may request; invalid callers, requests and sites consume no calls', async (t) => {
  let calls = 0;
  const f = fixture(t, {}, (p) => { calls++; return jsonAnswer(p); });
  await assert.rejects(f.book.request(req(), 'user'));
  for (const bad of [null, {}, { ...req(), unsupported: true }, { ...req(), brief: 'x'.repeat(1201) },
    req('bad', [0, 0, 14, 13]), req('bad', [0, 0, 13.5, 13]), req('bad', [4, 4, 2, 2]), req('bad', ['0', 0, 13, 13])]) {
    await assert.rejects(f.book.request(bad, 'gpt'));
  }
  assert.equal(calls, 0);
  for (const owner of IDS) {
    const { plan } = await f.book.request(req(`집 ${owner}`), owner);
    assert.equal(plan.owner, owner);
    f.book.cancel(plan.id, owner);
  }
  assert.equal(calls, 4);
});

test('dedup is shared between owners, ignores title/whitespace, and never records another call', async (t) => {
  let calls = 0;
  const f = fixture(t, {}, (p) => { calls++; return jsonAnswer(p); });
  const first = await f.book.request(req('작은 집'), 'claude');
  const duplicate = await f.book.request({ ...req('작은   집'), title: '다른 제목' }, 'deepseek');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.plan.id, first.plan.id);
  assert.equal(calls, 1);
  assert.equal(f.book.view().limits.used, 1);
});

test('whole-site blocks, signs and active reservations reject before the planner; auto-pick finds clear land', async (t) => {
  let calls = 0;
  const f = fixture(t, {}, (p) => { calls++; return jsonAnswer(p); });
  f.world.blocks.set('0,31,0', 'stone');
  await assert.rejects(f.book.request(req(), 'gpt'));
  f.world.blocks.clear();
  f.world.signs['13,31,13'] = { text: 'keep' };
  await assert.rejects(f.book.request(req(), 'gpt'));
  delete f.world.signs['13,31,13'];
  const a = await f.book.request(req('a'), 'gpt');
  await assert.rejects(f.book.request(req('b', [10, 0, 23, 13]), 'gemini'));
  assert.equal(calls, 1);
  assert.throws(() => f.book.assertRawChanges([[13, 31, 13, null]]));
  const b = await f.book.request(req('새 부지', null), 'gemini');
  assert.ok(b.plan.site[0] > 13 || b.plan.site[1] > 13);
  assert.deepEqual(a.plan.site, siteA);
});

test('in-flight guard is persisted, duplicate requests share the draft, cancel releases reservations only', async (t) => {
  const wait = deferred(); let calls = 0;
  const f = fixture(t, {}, () => { calls++; return wait.promise; });
  const pending = f.book.request(req(), 'claude');
  await Promise.resolve();
  const restart = f.restart();
  const dup = await restart.request(req(), 'gemini');
  assert.equal(dup.duplicate, true);
  await assert.rejects(restart.request(req('other', siteB), 'gpt'), /처리 중/);
  assert.throws(() => restart.cancel(dup.plan.id, 'gpt'), /설계한/);
  restart.cancel(dup.plan.id, 'claude');
  assert.equal(restart.assertRawChanges([[0, 1, 0]]), true);
  await assert.rejects(restart.request(req('other', siteB), 'gpt'), /처리 중/);
  wait.resolve({ ok: true, text: JSON.stringify(recipe()), ms: 1 });
  assert.equal((await pending).plan.status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(f.world.blocks.size, 0);
});

test('room-off before/after the call never builds and after-call result is cancelled', async (t) => {
  const wait = deferred(); let running = false, calls = 0;
  const f = fixture(t, {}, () => { calls++; return wait.promise; });
  await assert.rejects(f.book.request(req(), 'gpt', { isRunning: () => running }));
  assert.equal(calls, 0);
  running = true;
  const pending = f.book.request(req(), 'gpt', { isRunning: () => running });
  await Promise.resolve();
  running = false;
  wait.resolve({ ok: true, text: JSON.stringify(recipe()), ms: 1 });
  const { plan } = await pending;
  assert.equal(plan.status, 'cancelled');
  assert.equal(f.world.blocks.size, 0);
  assert.equal(f.book.assertRawChanges([[0, 1, 0]]), true);
  assert.throws(() => f.book.execute({ id: plan.id, stage: 1 }, 'gemini', { isRunning: () => false }));
});

test('site changes during a real call fail the draft and leave the external blocks intact', async (t) => {
  const wait = deferred();
  const f = fixture(t, {}, () => wait.promise);
  const pending = f.book.request(req(), 'gpt');
  f.world.blocks.set('13,31,13', 'gold');
  wait.resolve({ ok: true, text: JSON.stringify(recipe()), ms: 1 });
  await assert.rejects(pending, /부지가 바뀌/);
  assert.equal(f.world.blocks.get('13,31,13'), 'gold');
  assert.equal(f.book.view().plans[0].status, 'failed');
  assert.equal(f.book.assertRawChanges([[0, 1, 0]]), true);
});

test('fenced and balanced recipe JSON work; invalid JSON, extra fields and model failures never retry', async (t) => {
  for (const text of ['```json\n' + JSON.stringify(recipe()) + '\n```', '설계:\n' + JSON.stringify(recipe()) + '\n끝.']) {
    const f = fixture(t, {}, () => ({ ok: true, text, ms: 0 }));
    assert.equal((await f.book.request(req(), 'gpt')).plan.status, 'draft');
  }
  for (const text of ['{}', '[]', '{"kind":', JSON.stringify(recipe()) + '\n{}', '[' + JSON.stringify(recipe()) + ']',
    JSON.stringify({ ...recipe(), rawOps: [] }), JSON.stringify({ ...recipe(), size: [12, 7] })]) {
    let calls = 0;
    const f = fixture(t, {}, () => { calls++; return { ok: true, text, ms: 0 }; });
    await assert.rejects(f.book.request(req(), 'gpt'));
    assert.equal(calls, 1);
    assert.equal(f.book.view().limits.used, 1);
    assert.equal(f.book.view().plans[0].status, 'failed');
    assert.equal(f.book.assertRawChanges([[0, 1, 0]]), true);
  }
  const f = fixture(t, {}, () => { throw Error('gpt-6-astra SECRET model output'); });
  await assert.rejects(f.book.request(req(), 'gpt'), (e) => !/SECRET|astra/.test(e.message));
  assert.ok(!/SECRET|astra/.test(JSON.stringify(f.book.view())));
});

test('rolling daily and member/room cooldowns survive restart; failed calls use quota', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const f = fixture(t, { cooldownSec: 900, memberCooldownSec: 1800 }, () => { calls++; return { ok: false }; });
  await assert.rejects(f.book.request(req(), 'gpt'));
  const readiness = f.restart().view();
  assert.equal(readiness.nextRequestAt, now + 900000);
  assert.equal(readiness.memberReadyAt.gpt, now + 1800000);
  assert.equal(readiness.memberReadyAt.gemini, now + 900000);
  assert.match(f.book.summary(), /설계 요청 대기.*900초/);
  await assert.rejects(f.restart().request(req('a'), 'claude'), /방의/);
  now += 900000;
  await assert.rejects(f.restart().request(req('b'), 'gpt'), /네 설계/);
  await assert.rejects(f.restart().request(req('c'), 'claude'), /호출/);
  now += 900000;
  for (let i = 0; i < 4; i++) {
    await assert.rejects(f.restart().request(req(`fail ${i}`), i % 2 ? 'claude' : 'gpt'), /호출/);
    now += 900000;
  }
  assert.equal(calls, 6);
  assert.equal(f.restart().view().nextRequestAt, f.book.state.attempts[0].at + 86400000);
  await assert.rejects(f.restart().request(req('seventh'), 'gemini'), /24시간/);
  assert.equal(calls, 6);
  now += 86400000;
  await assert.rejects(f.restart().request(req('after day'), 'gemini'), /호출/);
  assert.equal(calls, 7);
});

test('disabled planner summaries explain its state while keeping existing reservations protected', async (t) => {
  const f = fixture(t);
  await f.book.request(req(), 'gpt');
  const off = new PlanBook(f.home, { planner: { enabled: false } }, f.world, jsonAnswer);
  assert.equal(off.view().enabled, false);
  assert.match(off.summary(), /현재 꺼져/);
  await assert.rejects(off.request(req('new', siteB), 'claude'), /꺼져/);
  assert.throws(() => off.assertRawChanges([[13, 31, 13]]));
});

test('timeout consumes quota, exposes no late result, and keeps singleflight until actual completion', async (t) => {
  const wait = deferred();
  const f = fixture(t, { timeoutSec: 0.01 }, () => wait.promise);
  await assert.rejects(f.book.request(req(), 'gpt'), /시간이 초과/);
  assert.equal(f.book.view().limits.used, 1);
  await assert.rejects(f.book.request(req('other', siteB), 'claude'), /처리 중/);
  wait.resolve({ ok: true, text: JSON.stringify(recipe()), ms: 30 });
  await Promise.resolve();
  assert.equal(f.book.view().plans[0].status, 'failed');
  assert.equal(f.world.blocks.size, 0);
});

test('per-plan cooldown survives restart without blocking unrelated plans; stage indexes are strict', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { stageCooldownSec: 300 });
  const a = (await f.book.request(req('a'), 'gpt')).plan;
  const b = (await f.book.request(req('b', siteB), 'claude')).plan;
  for (const stage of [0, -1, '1', 1.2, 2, 5]) assert.throws(() => f.book.execute({ id: a.id, stage }, 'deepseek'));
  f.book.execute({ id: a.id, stage: 1 }, 'gemini');
  const restarted = f.restart();
  assert.ok(restarted.execute({ id: b.id, stage: 1 }, 'deepseek').advanced);
  assert.throws(() => restarted.execute({ id: a.id, stage: 'next' }, 'deepseek'), /시공 대기/);
  assert.equal(restarted.execute({ id: a.id, stage: 1 }, 'claude').changes.length, 0);
  now += 300000;
  assert.ok(restarted.execute({ id: b.id, stage: 'next' }, 'deepseek').changes.length);
});

test('any external change to reserved air or built cells blocks the entire next stage', async (t) => {
  for (const mutate of [(w) => w.blocks.set('13,31,13', 'stone'), (w) => w.blocks.delete('2,1,2'),
    (w) => { w.signs['13,2,13'] = { text: 'new sign' }; }]) {
    const f = fixture(t);
    const { plan } = await f.book.request(req(), 'gpt');
    f.book.execute({ id: plan.id, stage: 1 }, 'gpt');
    mutate(f.world);
    const before = [...f.world.blocks];
    assert.throws(() => f.book.execute({ id: plan.id, stage: 2 }, 'claude'), /외부/);
    assert.deepEqual([...f.world.blocks], before);
    assert.equal(f.book.view().plans[0].status, 'blocked');
    assert.throws(() => f.book.assertRawChanges([[13, 31, 13]]));
    f.book.cancel(plan.id, 'gpt');
    assert.deepEqual([...f.world.blocks], before);
    assert.equal(f.book.assertRawChanges([[13, 31, 13]]), true);
  }
});

test('identical next-stage blocks without a pending journal are external interference', async (t) => {
  const f = fixture(t);
  const { plan } = await f.book.request(req(), 'gpt');
  const raw = JSON.parse(fs.readFileSync(f.book.file));
  f.world.applyCells(raw.plans[0].compiled.stages[0].cells, 'claude');
  assert.throws(() => f.book.execute({ id: plan.id, stage: 1 }, 'gpt'), /외부/);
  assert.equal(f.book.view().plans[0].completedStages, 0);
});

test('crash after durable world commit but before plan bookmark recovers precisely once', async (t) => {
  const f = fixture(t);
  const { plan } = await f.book.request(req(), 'gpt');
  const save = f.book._save.bind(f.book);
  let writes = 0;
  f.book._save = () => { if (++writes === 2) throw Error('simulated bookmark failure'); save(); };
  assert.throws(() => f.book.execute({ id: plan.id, stage: 1 }, 'claude'), /bookmark/);
  const disk = JSON.parse(fs.readFileSync(f.book.file));
  assert.equal(disk.plans[0].done, 0);
  assert.equal(disk.plans[0].pending.stage, 1);
  const restarted = f.restart();
  const savedWorld = fs.readFileSync(restarted.world.file, 'utf8');
  const result = restarted.execute({ id: plan.id, stage: 1 }, 'gemini');
  assert.deepEqual(result.changes, disk.plans[0].compiled.stages[0].cells);
  assert.equal(result.plan.completedStages, 1);
  assert.equal(fs.readFileSync(restarted.world.file, 'utf8'), savedWorld);
  assert.equal(restarted.world.log.length, 1);
  assert.deepEqual(restarted.execute({ id: plan.id, stage: 1 }, 'gemini').changes, []);
  assert.ok(restarted.execute({ id: plan.id, stage: 2 }, 'deepseek').changes.length);
});

test('recovery merges viewer resync cells with the newly requested next stage without duplicating world logs', async (t) => {
  const f = fixture(t);
  const { plan } = await f.book.request(req(), 'gpt');
  const save = f.book._save.bind(f.book);
  let writes = 0;
  f.book._save = () => { if (++writes === 2) throw Error('bookmark failed'); save(); };
  assert.throws(() => f.book.execute({ id: plan.id, stage: 1 }, 'claude'), /bookmark/);
  const stored = JSON.parse(fs.readFileSync(f.book.file)).plans[0];
  const restarted = f.restart();
  const result = restarted.execute({ id: plan.id, stage: 2 }, 'gemini');
  assert.deepEqual(result.changes, [...stored.compiled.stages[0].cells, ...stored.compiled.stages[1].cells]);
  assert.equal(result.plan.completedStages, 2);
  assert.equal(restarted.world.log.length, 2);
  assert.equal(restarted.world.blocks.size, result.changes.length);
});

test('write-ahead failure prevents world changes; world-write failure retains an exactly retryable journal', async (t) => {
  const f = fixture(t);
  const { plan } = await f.book.request(req(), 'gpt');
  const save = f.book._save.bind(f.book);
  f.book._save = () => { throw Error('no WAL'); };
  assert.throws(() => f.book.execute({ id: plan.id, stage: 1 }, 'gpt'), /WAL/);
  assert.equal(f.world.blocks.size, 0);
  f.book._save = save;
  const apply = f.world.applyCells.bind(f.world);
  f.world.applyCells = () => { throw Error('world disk failure'); };
  assert.throws(() => f.book.execute({ id: plan.id, stage: 1 }, 'gpt'), /disk/);
  assert.equal(JSON.parse(fs.readFileSync(f.book.file)).plans[0].pending.stage, 1);
  f.world.applyCells = apply;
  assert.ok(f.book.execute({ id: plan.id, stage: 1 }, 'gpt').changes.length);
});

test('an unapplied pending transaction prevents cross-plan overtaking and starts its cooldown at the successful retry', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { stageCooldownSec: 300 });
  const a = (await f.book.request(req('a'), 'gpt')).plan;
  const b = (await f.book.request(req('b', siteB), 'claude')).plan;
  const apply = f.world.applyCells.bind(f.world);
  f.world.applyCells = () => { throw Error('disk unavailable'); };
  assert.throws(() => f.book.execute({ id: a.id, stage: 1 }, 'gpt'), /disk/);
  f.world.applyCells = apply;
  now += 300000;
  assert.throws(() => f.book.execute({ id: b.id, stage: 1 }, 'gemini'), /다른 시공/);
  assert.ok(f.book.execute({ id: a.id, stage: 1 }, 'deepseek').changes.length);
  assert.equal(f.book.view().plans.find((p) => p.id === a.id).nextStageAt, now + 300000);
  assert.throws(() => f.book.execute({ id: a.id, stage: 2 }, 'gpt'), /시공 대기/);
});

test('corrupt ledgers keep the constructor alive, block all writes, and never reset quota or overwrite evidence', async (t) => {
  const f = fixture(t);
  await f.book.request(req(), 'gpt');
  const valid = fs.readFileSync(f.book.file, 'utf8');
  for (const corrupt of ['{invalid', '{}', JSON.stringify({ ...JSON.parse(valid), attempts: null }),
    valid.replace('"stageChecksums":["', '"stageChecksums":["tampered')]) {
    fs.writeFileSync(f.book.file, corrupt);
    const book = f.restart();
    assert.ok(book.loadError);
    assert.ok(book.view().error);
    assert.equal(book.view().limits.used, null);
    await assert.rejects(book.request(req(), 'gpt'), /기록/);
    assert.throws(() => book.execute({ id: 'nope', stage: 1 }, 'gpt'), /기록/);
    assert.throws(() => book.cancel('nope', 'gpt'), /기록/);
    assert.throws(() => book.assertRawChanges([[47, 1, 47]]), /기록/);
    assert.equal(fs.readFileSync(f.book.file, 'utf8'), corrupt);
  }
});

test('whim offers persist once per hour and twelve new Bianca text messages, without per-prompt writes', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const messages = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, from: 'gemini', text: '이야기', ts: now - 1000 }));
  assert.equal(f.book.whimCue('gemini', 'spark', messages.slice(0, 11), now), '');
  assert.equal(f.book.whimCue('gpt', 'spark', messages, now), '');
  assert.equal(f.book.whimCue('gemini', 'new', messages, now), '');
  assert.ok(f.book.whimCue('gemini', 'spark', messages, now).includes('예배당'));
  const saved = fs.readFileSync(f.book.file, 'utf8');
  assert.equal(f.book.whimCue('gemini', 'idle', messages, now + 1), '');
  assert.equal(fs.readFileSync(f.book.file, 'utf8'), saved);
  const more = Array.from({ length: 12 }, (_, i) => ({ id: i + 13, from: 'gemini', text: '새 이야기', ts: now + 1000 }));
  assert.equal(f.restart().whimCue('gemini', 'idle', more, now + 3599999), '');
  assert.equal(f.restart().whimCue('gemini', 'idle', more.slice(0, 11), now + 3600000), '');
  assert.ok(f.restart().whimCue('gemini', 'idle', more, now + 3600000));
});

const largeRecipe = () => ({ ...recipe(), origin: [1, 1], size: [11, 11] });
const largeAnswer = () => ({ ok: true, text: JSON.stringify(largeRecipe()) });
const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = (cells) => ({ cells: structuredClone(cells).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]), signs: [] });

test('next consumes <=80 cells atomically within unchanged macro phases; restart and duplicate are distinct', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { stageCooldownSec: 25 }, largeAnswer);
  const { plan } = await f.book.request(req(), 'gpt');
  const compiled = JSON.stringify(f.book.state.plans[0].compiled);
  assert.equal(f.book.nextContinuation(), null);
  const first = f.book.execute({ id: '#1', stage: 'next' }, 'claude');
  assert.equal(first.changes.length, 80);
  assert.equal(first.plan.completedStages, 0);
  assert.equal(first.plan.stageOffset, 80);
  assert.equal(first.plan.nextStage, 1);
  assert.equal(first.plan.continuation, null);
  const secondBook = new PlanBook(f.home, f.cfg, f.world, largeAnswer);
  assert.throws(() => secondBook.execute({ id: plan.id, stage: 'next' }, 'gemini'), (e) => e.code === 'stage_cooldown' && e.retryAfterSec === 25);
  now += 24001;
  assert.equal(secondBook.view().plans[0].stageWaitSec, 1);
  now += 999;
  const second = secondBook.execute({ id: '#1', stage: 'next' }, 'gemini');
  assert.equal(second.changes.length, 41);
  assert.equal(second.plan.completedStages, 1);
  const replay = secondBook.execute({ id: '#1', stage: 1, continue: true }, 'gpt');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.advanced, false);
  assert.equal(replay.recovered, false);
  assert.equal(replay.plan.continuation, null); // a replay is not fresh consent
  assert.equal(replay.changes.length, 0);
  assert.equal(JSON.stringify(secondBook.state.plans[0].compiled), compiled);
  assert.equal(secondBook.view().limits.used, 1);
  for (const id of ['1', '#01', '#0', '#-1', '#1suffix', '#9007199254740993']) {
    assert.throws(() => secondBook.execute({ id, stage: 'next' }, 'gpt'), (e) => e.code === 'plan_missing');
  }
});

test('microstep WAL recovery never adds a second chunk or log, and retains explicit continuation across restart', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { stageCooldownSec: 25 }, largeAnswer);
  await f.book.request(req(), 'gpt');
  const save = f.book._save.bind(f.book); let writes = 0;
  f.book._save = () => { if (++writes === 2) throw Error('bookmark failure'); save(); };
  assert.throws(() => f.book.execute({ id: '#1', stage: 'next', continue: true }, 'claude'), /bookmark/);
  const disk = JSON.parse(fs.readFileSync(f.book.file));
  assert.equal(disk.plans[0].pending.to, 80);
  assert.equal(disk.plans[0].stageOffset, 0);
  assert.equal(disk.plans[0].continuation.by, 'claude');
  now += 25000;
  const restarted = f.restart();
  const recovered = restarted.execute({ id: '#1', stage: 'next' }, 'claude');
  assert.equal(recovered.advanced, false);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.duplicate, false);
  assert.equal(recovered.plan.stageOffset, 80);
  assert.equal(restarted.world.blocks.size, 80);
  assert.equal(restarted.world.log.length, 1);
  assert.equal(restarted.nextContinuation().nextDueAt, now + 25000);
  now += 25000;
  assert.equal(restarted.execute({ id: '#1', stage: 'next' }, 'claude', { scheduled: true }).changes.length, 41);
  assert.equal(restarted.world.log.length, 2);
});

test('voluntary continuation pause/resume is durable and limited to owner or starter; cancelled plans never wake', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { stageCooldownSec: 25 });
  await f.book.request(req(), 'gpt');
  assert.equal(f.book.nextContinuation(), null);
  f.book.execute({ id: '#1', stage: 'next', continue: true }, 'claude');
  assert.throws(() => f.book.pause('#1', 'gemini'), (e) => e.code === 'continuation_owner');
  f.book.pause('#1', 'claude');
  const restarted = f.restart();
  assert.equal(restarted.nextContinuation(), null);
  now += 25000;
  assert.throws(() => restarted.execute({ id: '#1', stage: 'next' }, 'gpt'), (e) => e.code === 'plan_paused');
  assert.throws(() => restarted.execute({ id: '#1', stage: 'next', continue: true }, 'gemini'), (e) => e.code === 'continuation_owner');
  assert.equal(restarted.execute({ id: '#1', stage: 'next' }, 'claude', { scheduled: true }), null);
  restarted.execute({ id: '#1', stage: 'next', continue: true }, 'gpt');
  assert.equal(restarted.nextContinuation().by, 'gpt');
  const blocks = [...restarted.world.blocks];
  restarted.cancel('#1', 'gpt');
  assert.deepEqual([...restarted.world.blocks], blocks);
  assert.equal(restarted.nextContinuation(), null);
  assert.equal(restarted.execute({ id: '#1', stage: 'next' }, 'gpt', { scheduled: true }), null);
});

test('each scheduled chunk validates collisions and halts rather than overwriting external changes', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { stageCooldownSec: 25 }, largeAnswer);
  await f.book.request(req(), 'gpt');
  f.book.execute({ id: '#1', stage: 'next', continue: true }, 'gpt');
  f.world.blocks.set('13,31,13', 'gold');
  const before = [...f.world.blocks]; now += 25000;
  assert.throws(() => f.book.execute({ id: '#1', stage: 'next' }, 'gpt', { scheduled: true }), (e) => e.code === 'site_changed');
  assert.deepEqual([...f.world.blocks], before);
  assert.equal(f.book.view().plans[0].status, 'blocked');
  assert.equal(f.book.view().plans[0].continuation.paused, true);
  assert.equal(f.book.nextContinuation(), null);
});

test('legacy v1 full-stage progress and WAL load unchanged without implicit jobs or global cooldown', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { stageCooldownSec: 25 });
  const a = (await f.book.request(req('a'), 'gpt')).plan;
  const b = (await f.book.request(req('b', siteB), 'claude')).plan;
  const state = JSON.parse(fs.readFileSync(f.book.file));
  const p = state.plans[0], cells = p.compiled.stages[0].cells;
  for (const plan of state.plans) for (const key of ['stageOffset', 'lastStageAt', 'continuation']) delete plan[key];
  p.pending = { stage: 1, by: 'gpt', at: now, beforeHash: p.expectedHash, afterHash: fingerprint(snapshot(cells)) };
  state.lastStageAt = now + 600000; // unrelated historical room-wide pacing is not a new lock
  fs.writeFileSync(f.book.file, JSON.stringify(state));
  f.world.applyCells(cells, 'gpt');
  const restarted = f.restart();
  assert.equal(restarted.loadError, null);
  assert.equal(restarted.nextContinuation(), null);
  const recovered = restarted.execute({ id: a.id, stage: 'next' }, 'gpt');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.plan.completedStages, 1);
  assert.equal(recovered.plan.continuation, null);
  assert.equal(restarted.execute({ id: b.id, stage: 'next' }, 'claude').advanced, true);
  assert.equal(restarted.view().limits.used, 2);
  assert.deepEqual(restarted.state.plans[0].compiled, p.compiled);
});

test('corrupt microstep and continuation metadata fails closed without rewriting the ledger', async (t) => {
  const f = fixture(t, {}, largeAnswer);
  await f.book.request(req(), 'gpt');
  f.book.execute({ id: '#1', stage: 'next', continue: true }, 'gpt');
  const good = JSON.parse(fs.readFileSync(f.book.file));
  for (const mutate of [
    (p) => { p.stageOffset++; },
    (p) => { p.continuation.nextDueAt = 'tomorrow'; },
    (p) => { p.continuation.by = 'user'; },
    (p) => { p.continuation.paused = true; },
    (p) => { p.compiled.stages[1].cells[0][3] = 'gold'; },
  ]) {
    const state = structuredClone(good); mutate(state.plans[0]);
    const bytes = JSON.stringify(state); fs.writeFileSync(f.book.file, bytes);
    const broken = f.restart();
    assert.ok(broken.loadError);
    assert.throws(() => broken.execute({ id: '#1', stage: 'next' }, 'gpt'));
    assert.equal(fs.readFileSync(f.book.file, 'utf8'), bytes);
  }
});

test('busy requests expose actionable retry reasons without queueing, quota consumption, or timeout-as-ETA', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const wait = deferred(); let calls = 0;
  const f = fixture(t, { cooldownSec: 900, memberCooldownSec: 1800 }, () => { calls++; return wait.promise; });
  const pending = f.book.request(req(), 'gpt');
  await Promise.resolve();
  await assert.rejects(f.book.request(req('another', siteB), 'claude'), (e) => e.code === 'planner_busy' && e.queued === false && e.retryAfterSec === 900);
  assert.equal(f.book.view().requestWaitSec, 900);
  assert.equal(f.book.view().limits.used, 1);
  now += 10000;
  assert.equal(f.book.view().requestWaitSec, 890);
  assert.match(f.book.summary(), /890초/);
  assert.doesNotMatch(f.book.summary(), /\d{4}-\d\d-\d\dT/);
  wait.resolve(jsonAnswer('test\n' + JSON.stringify({ site: siteA })));
  await pending;
  assert.equal(calls, 1);
});
