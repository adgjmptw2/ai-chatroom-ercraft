import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BubblePacer, scheduleConversationRead } from '../lib/conversation-efficiency.mjs';
import { restIntent } from '../lib/household-flow.mjs';
const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const speeds = vm.runInNewContext(source.match(/const SPEEDS = \{[^]*?^};/m)[0] + '\nSPEEDS;');

test('all presets slow down actual replies and the batched adapter honors the selected speed', () => {
  const schedule = source.match(/^function scheduleGeminiRead\([^]*?^}/m)[0];
  const context = vm.createContext({ SPEEDS: speeds, room: { speed: 'slow' },
    scheduleConversationRead, rand: (lo) => lo, isCalled: () => true });
  vm.runInContext(schedule + '\nglobalThis.schedule = scheduleGeminiRead;', context);
  for (const [mode, delay, gap] of [['slow', 25000, 12], ['normal', 12000, 7], ['fast', 5000, 4]]) {
    context.room.speed = mode;
    const actor = { id: 'gemini' };
    context.schedule(actor, [{ id: 1, from: 'gpt' }], 100000, true);
    assert.equal(actor.wakeAt, 100000 + delay);
    assert.equal(speeds[mode].bubbleGap, gap);
  }
});

test('actual perform path spaces multiple bubbles and still executes silent movement', async () => {
  let now = 0;
  const posted = [], actions = [];
  const context = vm.createContext({ shuttingDown: false, room: { running: true, sleeping: false, speed: 'slow' },
    SPEEDS: speeds, bubblePacer: new BubblePacer(), formatMemberSpeech: (_id, text) => text,
    Date: { now: () => now }, store: { after: () => [], getMessage: () => null },
    restIntent, setStatus() {}, typingDelay: () => 0, sleep: async ms => { now += ms; },
    post: msg => posted.push({ at: now, text: msg.text }),
    performWorldAction: async (_id, act) => { actions.push(act); return false; } });
  // The default clock is captured by BubblePacer's defining realm; use an explicit
  // fixture clock while still executing the real gate and server perform code.
  const pacer = new BubblePacer();
  context.bubblePacer = { wait: options => pacer.wait({ ...options, now: () => now }) };
  vm.runInContext(source.match(/^async function perform\([^]*?^}/m)[0] + '\nglobalThis.perform = perform;', context);
  await context.perform({ id: 'gpt' }, { action: 'say', messages: ['하나', '둘', '셋'] }, 0, 'new');
  assert.deepEqual(posted.map(m => m.at), [0, 12000, 24000]);
  await context.perform({ id: 'gpt' }, { action: 'pass', move: [23, 22] }, 0, 'new');
  assert.deepEqual(actions.at(-1).move, [23, 22]);
  assert.equal(posted.length, 3);
});

test('host addressed during peer mention wait gets an earlier deadline; no mention postpones a reply', () => {
  const branch = source.match(/} else if \(!a.wakeAt \|\| directHost[^]*?\n      }/)[0].replace(/^} else /, '');
  const c = vm.createContext({ a: { wakeAt: 50000, reason: 'urgent' }, directHost: true, urgent: true,
    now: 1000, sp: speeds.slow, rand: lo => lo });
  vm.runInContext(branch, c);
  assert.equal(c.a.wakeAt, 13000);
  c.a = { wakeAt: 7000, reason: 'new' }; c.directHost = false;
  vm.runInContext(branch, c);
  assert.equal(c.a.wakeAt, 7000);
  const inflight = source.match(/let inflight = ([^;]+);/)[1];
  assert.equal(vm.runInNewContext(inflight, { AI_IDS: ['a','b','c','d'], agents: {
    a: {busy:true,pacing:true}, b: {busy:true,pacing:true}, c:{busy:true,pacing:false}, d:{busy:false} } }), 1);
});
