import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanBook, PlanError, DEFAULT_PLANNER_CFG, freshPlanLedger } from '../lib/plans.mjs';
import { World } from '../lib/world.mjs';

const IDS = ['claude', 'gpt', 'deepseek', 'gemini'];
const request = (brief, site) => ({ title: brief, brief, ...(site ? { site } : {}) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const answer = (prompt) => {
  const { site } = JSON.parse(prompt.split('\n').at(-1));
  return { ok: true, text: JSON.stringify({ kind: 'house', origin: [site[0] + 2, site[1] + 2], size: [7, 7],
    wallHeight: 3, front: 's', materials: { foundation: 'stone', wall: 'white', trim: 'log', floor: 'planks',
      roof: 'black', window: 'glass', accent: 'purple' }, roof: { type: 'gable', ridge: 'x', overhang: 1 },
    windows: { spacing: 3, height: 1, sill: 1 }, features: [] }) };
};

function fixture(t, { planner = answer, cfg = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chatroom-queue-test-'));
  const config = { planner: { ...DEFAULT_PLANNER_CFG, cooldownSec: 0, memberCooldownSec: 0, ...cfg } };
  const world = new World(home, IDS), calls = [];
  const run = (prompt) => { calls.push({ prompt, ...JSON.parse(prompt.split('\n').at(-1)) }); return planner(prompt); };
  const book = new PlanBook(home, config, world, run);
  t.after(() => {
    clearTimeout(world.saveTimer);
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('ai-chatroom-queue-test-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, config, world, book, calls, restart: () => new PlanBook(home, config, world, run) };
}

test('parallel admissions are durable FIFO, reserve distinct sites and dispatch only one head across instances', async (t) => {
  const wait = deferred();
  const f = fixture(t, { planner: (prompt) => f.calls.length === 1 ? wait.promise : answer(prompt) });
  const peer = f.restart();
  const received = await Promise.all(IDS.map((by, i) => Promise.resolve().then(() => (i % 2 ? peer : f.book).enqueue(request(`home-${i}`), by))));
  assert.deepEqual(received.map((r) => r.position), [1, 2, 3, 4]);
  assert.ok(received.every((r) => r.queued && !r.duplicate && r.plan.status === 'queued' && !r.plan.preparing));
  assert.equal(new Set(received.map((r) => r.plan.site.join(','))).size, 4);
  assert.equal(f.calls.length, 0);
  assert.equal(f.book.view().limits.used, 0);
  assert.equal(f.book.view().queue.total, 4);
  assert.throws(() => peer.enqueue(request('fifth'), 'claude'), (e) => e.code === 'member_queue_full');
  assert.throws(() => f.book.assertRawChanges([[0, 31, 0, 'stone']]), /예약/);
  let accounted = 0;
  const first = f.book.processNext({ onCall: ({ by }) => { accounted++; assert.equal(by, 'claude'); } });
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  assert.equal(f.book.view().plans[0].preparing, true);
  assert.equal(f.book.view().plans[0].queued, false);
  assert.equal(f.book.view().plans[1].queuePosition, 1);
  assert.equal(f.book.view().plans[1].queueWaitReason, 'inflight');
  assert.equal(await peer.processNext(), null);
  assert.equal(await f.restart().processNext(), null);
  const pendingState = JSON.parse(fs.readFileSync(f.book.file));
  assert.equal(pendingState.inflight.ownerPid, process.pid);
  assert.equal(pendingState.attempts.length, 1);
  assert.equal(pendingState.attempts[0].status, 'pending');
  wait.resolve(answer(f.calls[0].prompt));
  assert.equal((await first).plan.id, received[0].plan.id);
  assert.equal(accounted, 1);
  for (const receipt of received.slice(1)) assert.equal((await peer.processNext()).plan.id, receipt.plan.id);
  assert.deepEqual(f.calls.map((c) => c.request.brief), ['home-0', 'home-1', 'home-2', 'home-3']);
  assert.equal(await f.book.processNext(), null);
  assert.equal(f.book.view().limits.used, 4);
  assert.equal(f.world.blocks.size, 0);
  assert.ok(f.book.view().plans.every((p) => p.status === 'draft' && !p.preparing && p.continuation === null));
});

test('dedup preserves exact ledger bytes, owner, order and quota while queued, inflight and ready', async (t) => {
  const wait = deferred();
  const f = fixture(t, { planner: () => wait.promise });
  const first = f.book.enqueue(request('a small house'), 'claude');
  f.book.enqueue(request('another'), 'gpt');
  const check = () => {
    const before = fs.readFileSync(f.book.file, 'utf8');
    const duplicate = f.restart().enqueue({ title: 'different title', brief: 'a   small house' }, 'gemini');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.plan.id, first.plan.id);
    assert.equal(duplicate.plan.owner, 'claude');
    assert.equal(fs.readFileSync(f.book.file, 'utf8'), before);
    return duplicate;
  };
  assert.equal(check().position, 1);
  const running = f.book.processNext(); await Promise.resolve();
  assert.equal(check().plan.preparing, true);
  assert.equal(check().queued, false);
  assert.equal(f.calls.length, 1);
  wait.resolve(answer(f.calls[0].prompt)); await running;
  assert.equal(check().plan.status, 'draft');
  assert.equal(check().plan.preparing, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.book.view().limits.used, 1);
});

test('admission ignores dispatch cooldowns, and strict FIFO does not bypass a cooling-down head', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { cfg: { cooldownSec: 15, memberCooldownSec: 60 } });
  f.book.enqueue(request('first'), 'claude');
  await f.book.processNext();
  const a = f.book.enqueue(request('second'), 'claude');
  const b = f.book.enqueue(request('third'), 'gpt');
  assert.equal(a.queued, true); assert.equal(b.position, 2);
  assert.equal(f.book.view().queue.nextDispatchAt, now + 60000);
  assert.equal(f.book.view().queue.waitSec, 60);
  assert.equal(await f.book.processNext(), null);
  now += 15000;
  assert.equal(f.restart().view().queue.reason, 'member_cooldown');
  assert.equal(f.book.view().plans[1].queueWaitSec, 45);
  assert.equal(await f.restart().processNext(), null);
  assert.equal(f.calls.length, 1);
  now += 45000;
  assert.equal((await f.restart().processNext()).plan.id, a.plan.id);
  assert.equal(await f.book.processNext(), null);
  now += 15000;
  assert.equal((await f.book.processNext()).plan.id, b.plan.id);
  assert.deepEqual(f.calls.map((c) => c.request.brief), ['first', 'second', 'third']);
});

test('quota is recorded only at actual dispatch; full-day quota accepts and retains queued work', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const attempts = Array.from({ length: 24 }, (_, i) => ({ id: `old-${i}`, by: IDS[i % 4], at: now - 1000, status: 'ok' }));
  fs.mkdirSync(path.dirname(f.book.file), { recursive: true });
  fs.writeFileSync(f.book.file, JSON.stringify(freshPlanLedger(attempts)));
  const accepted = f.book.enqueue(request('wait for quota'), 'gpt');
  assert.equal(accepted.queued, true);
  assert.equal(f.book.view().limits.used, 24);
  assert.equal(f.book.view().queue.reason, 'request_quota');
  assert.equal(await f.book.processNext(), null);
  assert.equal(f.calls.length, 0);
  now += 86400000;
  let onCalls = 0;
  await f.restart().processNext({ onCall: ({ id, by, at }) => {
    onCalls++;
    const disk = JSON.parse(fs.readFileSync(f.book.file));
    assert.equal(id, accepted.plan.id); assert.equal(by, 'gpt'); assert.equal(at, now);
    assert.equal(disk.attempts.length, 1);
    assert.equal(disk.attempts[0].status, 'pending');
    assert.equal(f.calls.length, 0);
  } });
  assert.equal(onCalls, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.book.view().limits.used, 1);
});

test('OFF/sleep and restart preserve queue bytes; a successful response arriving OFF becomes a draft', async (t) => {
  let running = true;
  const wait = deferred();
  const f = fixture(t, { planner: (p) => f.calls.length === 1 ? wait.promise : answer(p) });
  const first = f.book.enqueue(request('first'), 'claude');
  const second = f.book.enqueue(request('second'), 'gpt');
  const before = fs.readFileSync(f.book.file, 'utf8');
  running = false;
  assert.equal(await f.restart().processNext({ isRunning: () => running }), null);
  assert.equal(fs.readFileSync(f.book.file, 'utf8'), before);
  assert.throws(() => f.book.enqueue(request('off'), 'gemini', { isRunning: () => running }), (e) => e.code === 'room_stopped');
  running = true;
  const pending = f.book.processNext({ isRunning: () => running }); await Promise.resolve();
  running = false;
  wait.resolve(answer(f.calls[0].prompt));
  const result = await pending;
  assert.equal(result.plan.id, first.plan.id);
  assert.equal(result.plan.status, 'draft');
  assert.equal(result.plan.preparing, false);
  assert.equal(result.plan.continuation, null);
  assert.equal(f.world.blocks.size, 0);
  assert.equal(await f.restart().processNext({ isRunning: () => running }), null);
  assert.equal(f.book.view().queue.ids[0], second.plan.id);
  running = true;
  assert.equal((await f.restart().processNext({ isRunning: () => running })).plan.id, second.plan.id);
});

test('OFF after claim but before the provider restores FIFO without consuming a call or attempt', async (t) => {
  const f = fixture(t); let running = true, accounted = 0;
  const a = f.book.enqueue(request('a'), 'claude');
  const b = f.book.enqueue(request('b'), 'gpt');
  const pending = f.book.processNext({ isRunning: () => running, onCall: () => accounted++ });
  running = false;
  assert.equal(await pending, null);
  assert.equal(accounted, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.book.view().limits.used, 0);
  assert.deepEqual(f.book.view().queue.ids, [a.plan.id, b.plan.id]);
  assert.equal(f.book.view().pending, false);
});

test('cancelling queued work releases its reservation, consumes no quota, and cannot cancel another owner', async (t) => {
  const f = fixture(t);
  const a = f.book.enqueue(request('a', [0, 0, 13, 13]), 'claude');
  const b = f.book.enqueue(request('b'), 'gpt');
  assert.throws(() => f.book.cancel(a.plan.id, 'gpt'), /설계한/);
  assert.equal(f.book.cancel(a.plan.id, 'claude').status, 'cancelled');
  assert.equal(f.book.assertRawChanges([[0, 1, 0, 'stone']]), true);
  assert.equal(f.book.view().limits.used, 0);
  assert.equal(f.book.view().plans[1].queuePosition, 1);
  assert.equal((await f.restart().processNext()).plan.id, b.plan.id);
  assert.equal(f.calls.length, 1);
  assert.equal(await f.book.processNext(), null);
});

test('cancelling inflight work discards its response but holds the single executor and member slot until settled', async (t) => {
  const wait = deferred();
  const f = fixture(t, { planner: (p) => f.calls.length === 1 ? wait.promise : answer(p) });
  const a = f.book.enqueue(request('a'), 'claude');
  const b = f.book.enqueue(request('b'), 'gpt');
  const pending = f.book.processNext(); await Promise.resolve();
  f.book.cancel(a.plan.id, 'claude');
  assert.equal(await f.restart().processNext(), null);
  assert.throws(() => f.book.enqueue(request('replacement'), 'claude'), (e) => e.code === 'member_queue_full');
  wait.resolve(answer(f.calls[0].prompt));
  assert.equal((await pending).plan.status, 'cancelled');
  assert.equal(f.book.view().plans[0].count, 0);
  assert.equal((await f.book.processNext()).plan.id, b.plan.id);
  assert.equal(f.calls.length, 2);
  assert.equal(f.book.view().limits.used, 2);
});

test('provider and validation failures are durable, attributed to one plan, and never retried automatically', async (t) => {
  for (const response of [{ ok: false }, { ok: true, text: '{"bad":true}' }, new Error('PRIVATE provider detail')]) {
    await t.test(response instanceof Error ? 'exception' : JSON.stringify(response), async (t) => {
      const f = fixture(t, { planner: (p) => {
        if (f.calls.length > 1) return answer(p);
        if (response instanceof Error) throw response;
        return response;
      } });
      const a = f.book.enqueue(request('fails'), 'deepseek');
      const b = f.book.enqueue(request('succeeds'), 'gpt');
      await assert.rejects(f.book.processNext(), (e) => e instanceof PlanError && e.by === 'deepseek'
        && e.planId === a.plan.id && e.plan.id === a.plan.id && e.plan.status === 'failed' && !e.message.includes('PRIVATE'));
      assert.equal(f.restart().view().plans[0].status, 'failed');
      assert.equal((await f.restart().processNext()).plan.id, b.plan.id);
      assert.equal(await f.book.processNext(), null);
      assert.deepEqual(f.calls.map((c) => c.request.brief), ['fails', 'succeeds']);
      assert.equal(f.book.view().limits.used, 2);
      assert.equal(f.world.blocks.size, 0);
    });
  }
});

test('timeout retains a durable draining guard until actual settlement; late success is ignored with no retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const wait = deferred();
  const f = fixture(t, { cfg: { timeoutSec: 0.01 }, planner: (p) => f.calls.length === 1 ? wait.promise : answer(p) });
  const a = f.book.enqueue(request('slow'), 'claude');
  const b = f.book.enqueue(request('next'), 'gpt');
  const pending = f.book.processNext();
  const rejected = assert.rejects(pending, (e) => e.code === 'planner_timeout' && e.by === 'claude' && e.planId === a.plan.id);
  await Promise.resolve(); t.mock.timers.tick(11); await rejected;
  const ledger = JSON.parse(fs.readFileSync(f.book.file));
  assert.equal(ledger.inflight.draining, true);
  assert.equal(ledger.inflight.ownerPid, process.pid);
  assert.equal(ledger.attempts[0].status, 'failed');
  now += 600000;
  assert.equal(await f.restart().processNext(), null);
  assert.equal(f.calls.length, 1);
  wait.resolve(answer(f.calls[0].prompt));
  await wait.promise; await Promise.resolve(); await Promise.resolve();
  assert.equal(f.book.view().pending, false);
  assert.equal(f.book.view().plans[0].status, 'failed');
  assert.equal(f.book.view().plans[0].count, 0);
  assert.equal((await f.restart().processNext()).plan.id, b.plan.id);
  assert.equal(f.calls.length, 2);
  assert.equal(f.world.blocks.size, 0);
});

test('site edits during queueing fail only that request before quota or provider dispatch', async (t) => {
  const f = fixture(t);
  const a = f.book.enqueue(request('a', [0, 0, 13, 13]), 'claude');
  const b = f.book.enqueue(request('b'), 'gpt');
  f.world.blocks.set('13,31,13', 'gold');
  const before = [...f.world.blocks];
  await assert.rejects(f.book.processNext(), (e) => e.code === 'site_changed' && e.planId === a.plan.id && e.by === 'claude');
  assert.equal(f.calls.length, 0);
  assert.equal(f.book.view().limits.used, 0);
  assert.deepEqual([...f.world.blocks], before);
  assert.equal((await f.book.processNext()).plan.id, b.plan.id);
  assert.equal(f.book.view().plans[0].status, 'failed');
});

function persistedFlight(f, now, pid) {
  const a = f.book.enqueue(request('interrupted'), 'claude');
  const b = f.book.enqueue(request('waiting'), 'gpt');
  const state = JSON.parse(fs.readFileSync(f.book.file));
  state.plans[0].status = 'draft';
  state.attempts = [{ id: a.plan.id, by: 'claude', at: now - 100000, status: 'pending' }];
  state.inflight = { id: a.plan.id, until: now - 1, ...(pid === undefined ? {} : { ownerPid: pid }) };
  fs.writeFileSync(f.book.file, JSON.stringify(state));
  return { a, b };
}

test('expired inflight is not assumed dead: live, unknown and inaccessible owners retain the guard', async (t) => {
  for (const mode of ['live', 'legacy', 'permission']) await t.test(mode, async (t) => {
    const f = fixture(t);
    persistedFlight(f, Date.now(), mode === 'legacy' ? undefined : process.pid);
    if (mode === 'permission') t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    const before = fs.readFileSync(f.book.file, 'utf8');
    assert.equal(await f.restart().processNext(), null);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(f.book.file, 'utf8'), before);
    assert.equal(f.book.view().queue.reason, 'executor_unconfirmed');
    assert.equal(f.book.view().queue.recoveryRequired, true);
  });
});

test('dead server ownership cannot prove provider termination: pending and draining flights remain blocked', async (t) => {
  for (const mode of ['pending', 'draining']) await t.test(mode, async (t) => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    const f = fixture(t);
    const { a, b } = persistedFlight(f, now, 123456789);
    if (mode === 'draining') {
      const state = JSON.parse(fs.readFileSync(f.book.file));
      state.inflight.draining = true;
      state.attempts[0].status = 'failed';
      state.plans[0].status = 'failed';
      fs.writeFileSync(f.book.file, JSON.stringify(state));
    }
    const kill = process.kill;
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === 123456789) throw Object.assign(new Error('server gone; child may still run'), { code: 'ESRCH' });
      return kill(pid, signal);
    });
    const before = fs.readFileSync(f.book.file, 'utf8');
    let accounted = 0;
    for (const elapsed of [0, 600000, 2 * 86400000]) {
      now += elapsed;
      const restarted = f.restart();
      assert.equal(await restarted.processNext({ onCall: () => { accounted++; } }), null);
      const view = restarted.view();
      assert.equal(view.queue.inflightId, a.plan.id);
      assert.deepEqual(view.queue.ids, [b.plan.id]);
      assert.equal(view.queue.reason, 'executor_unconfirmed');
      assert.equal(view.queue.recoveryRequired, true);
      assert.equal(view.queue.nextDispatchAt, null);
      assert.equal(view.plans[0].status, mode === 'pending' ? 'draft' : 'failed');
      assert.equal(view.plans[1].status, 'queued');
      assert.equal(fs.readFileSync(f.book.file, 'utf8'), before);
    }
    // The compatibility entry point must not bypass the unresolved flight.
    await assert.rejects(f.restart().request(request('cannot bypass'), 'deepseek'), (e) => e.code === 'planner_busy');
    assert.equal(accounted, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(f.book.file, 'utf8'), before);
  });
});

test('claim and result persistence failures do not create duplicate provider calls or lose quota evidence', async (t) => {
  const f = fixture(t);
  const a = f.book.enqueue(request('a'), 'claude');
  const b = f.book.enqueue(request('b'), 'gpt');
  const save = f.book._save.bind(f.book);
  f.book._save = () => { throw Error('disk unavailable'); };
  await assert.rejects(f.book.processNext(), (e) => e.code === 'planner_claim_failed' && e.planId === a.plan.id);
  assert.equal(f.calls.length, 0);
  assert.equal(f.restart().view().plans[0].status, 'queued');
  assert.equal(f.restart().view().limits.used, 0);
  let writes = 0;
  f.book._save = () => { if (++writes === 2) throw Error('result write failed'); save(); };
  await assert.rejects(f.book.processNext(), (e) => e.code === 'planner_persist_failed' && e.planId === a.plan.id && e.by === 'claude');
  assert.equal(f.calls.length, 1);
  f.book._save = save;
  await assert.rejects(f.book.processNext(), (e) => e.code === 'planner_interrupted' && e.planId === a.plan.id);
  assert.equal((await f.book.processNext()).plan.id, b.plan.id);
  assert.deepEqual(f.calls.map((c) => c.request.brief), ['a', 'b']);
  assert.equal(f.book.view().limits.used, 2);
});

test('legacy immediate calls cannot overtake queue admissions, while shared duplicates still reuse them', async (t) => {
  const f = fixture(t);
  const first = f.book.enqueue(request('queued'), 'claude');
  assert.equal((await f.book.request(request('queued'), 'gpt')).plan.id, first.plan.id);
  await assert.rejects(f.book.request(request('overtake'), 'gpt'), (e) => e.code === 'planner_queued');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.book.processNext()).plan.id, first.plan.id);
});

test('config accepts up to 96 daily calls and composition guidance stays inside the existing schema', async (t) => {
  const f = fixture(t, { cfg: { maxPerDay: 96 } });
  for (const value of [0, 97, 1.5, '24']) assert.throws(() => new PlanBook(f.home, { planner: { maxPerDay: value } }, f.world, answer));
  f.book.enqueue(request('small well-composed house'), 'gpt');
  await f.book.processNext();
  const prompt = f.calls[0].prompt;
  for (const phrase of ['2~3종', '강조색은 한 가지', '창문의 간격·높이', '사용 가능한 내부 공간', '새 필드나 기능을 만들지 마']) assert.ok(prompt.includes(phrase));
  assert.ok(prompt.length < 24000);
  const plan = f.book.view().plans[0];
  assert.equal(plan.stages.length, 4);
  assert.ok(plan.count <= 2000);
  assert.ok(plan.stages.every((s) => s.count <= 600));
  assert.match(f.book.summary(), /접수·중복 확인은 호출을 소비하지 않아/);
});
