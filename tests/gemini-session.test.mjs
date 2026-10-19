import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { Adapters, running } from '../lib/agents.mjs';
import { GeminiSession, geminiIdentity, geminiReply } from '../lib/gemini-session.mjs';

const BRIEF = 'Keep the exact voice.\nInstructions and artifacts: 한글 🎨\n';
const TURN = 'Private notes\nHistory: first\r\nsecond\nCurrent turn: reply now.  ';
const ACTION = '{"action":"say","messages":["그건 내 취향이지!"],"files":[{"op":"write","path":"a.svg","content":"<svg>\\n🎨</svg>"}],"show":"a.svg"}';
const full = (brief = BRIEF, turn = TURN) => `${brief}\n\n=====\n\n${turn}`;
const arg = (call, name) => call.args.includes(name) ? call.args[call.args.indexOf(name) + 1] : undefined;

test('private game calls neither reuse nor invalidate the normal Gemini seed', async t => {
  const f = fixture(t);
  await f.adapter.chat('gemini', BRIEF, TURN);
  const seed = structuredClone(f.adapter.sessions.gemini.seed);
  f.queue.push({reply:{response:'{"action":"liar","op":"vote","target":"adina"}'}});
  const game = await f.adapter.chat('gemini', 'private role', 'private card', {game:true});
  assert.equal(game.ok, true);
  assert.equal(arg(f.calls.at(-1), '--conversation'), undefined);
  assert.deepEqual(f.adapter.sessions.gemini.seed, seed);
  f.queue.push({code:1});
  await f.adapter.chat('gemini', 'private role', 'private card', {game:true});
  assert.deepEqual(f.adapter.sessions.gemini.seed, seed);
  await f.adapter.chat('gemini', BRIEF, TURN);
  assert.equal(arg(f.calls.at(-1), '--conversation'), seed.id);
});

// Exercise Adapters.chat -> geminiChat -> real run(), mocking only child creation.
// No CLI discovery, real model call, production data or configuration is involved.
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chatroom-gemini-test-'));
  const calls = [], queue = [];
  t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
    const spec = queue.shift() || {};
    const call = { cmd, args: [...args], opts };
    calls.push(call);
    if (spec.throw) throw new Error(spec.throw);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    // No pid: a timeout can never kill a real process.
    let finished = false;
    call.finish = () => {
      if (finished) return;
      finished = true;
      const envelope = Object.hasOwn(spec, 'json') ? spec.json : {
        status: 'SUCCESS', conversation_id: arg(call, '--conversation') || `session-${calls.indexOf(call) + 1}`,
        response: ACTION, ...spec.reply,
      };
      child.stdout.write(Object.hasOwn(spec, 'stdout') ? spec.stdout : JSON.stringify(envelope));
      child.stderr.write(spec.stderr || '');
      if (spec.childError) child.emit('error', new Error(spec.childError));
      child.emit('close', Object.hasOwn(spec, 'code') ? spec.code : 0);
    };
    if (!spec.hold) child.stdin.on('finish', () => queueMicrotask(call.finish));
    return child;
  });
  syncBuiltinESMExports();
  const adapter = Object.assign(Object.create(Adapters.prototype), {
    root: home, bins: { agy: 'FAKE-AGY-ONLY' }, sessions: {},
    cfg: { webSearch: false, turnTimeoutSec: 150, boost: { timeoutSec: 240 }, agents: {
      gemini: { model: 'gemini-3.8-flash-medium', rotate: 4, boost: { model: 'gemini-3.8-flash-high' } },
    } },
  });
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(running.size, 0);
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('ai-chatroom-gemini-test-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { adapter, calls, queue, home, chat: (brief = BRIEF, turn = TURN, opts = {}) => adapter.chat('gemini', brief, turn, opts) };
}

test('real adapter sends the full brief once, exact turns on reuse, and rotates after four successes', async t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) {
    assert.equal(f.adapter.maxPromptChars('gemini'), 26000);
    const turn = `${TURN}\nHistory delta ${i}`;
    const result = await f.chat(BRIEF, turn);
    assert.equal(result.ok, true);
    assert.equal(result.text, ACTION);
    assert.equal(result.detail, '');
    const call = f.calls[i];
    const fresh = i % 4 === 0;
    const sessionId = i < 4 ? 'session-1' : 'session-5';
    assert.deepEqual(call.args, ['--model', 'gemini-3.8-flash-medium', '--output-format', 'json', '--print-timeout', '150s',
      ...(fresh ? [] : ['--conversation', sessionId]), '-p', fresh ? full(BRIEF, turn) : turn]);
    assert.equal(call.cmd, 'FAKE-AGY-ONLY');
    assert.equal(call.opts.cwd, path.join(f.home, 'data', 'cwd', 'gemini', 'chat'));
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(call.opts.env[name], path.join(f.home, 'data', 'tmp', 'agy'));
  }
  assert.equal(f.calls.length, 6, 'no additional model call');
  assert.equal(f.adapter.maxPromptChars('gpt'), 120000);
});

test('identity changes always start a fresh full-brief session before reuse', async t => {
  const changes = {
    'exact brief whitespace': f => { f.brief = `${BRIEF} `; },
    model: f => { f.adapter.cfg.agents.gemini.model = 'different-model'; },
    'agent settings': f => { f.adapter.cfg.agents.gemini.effort = 'high'; },
    'tool settings': f => { f.adapter.cfg.agents.gemini.tools = ['search_web']; },
    'web toggle': f => { f.adapter.cfg.webSearch = true; },
    'rotation setting': f => { f.adapter.cfg.agents.gemini.rotate = 5; },
    'CLI timeout setting': f => { f.adapter.cfg.turnTimeoutSec = 90; },
    'CLI executable': f => { f.adapter.bins.agy = 'FAKE-AGY-CHANGED'; },
    'work path': f => { f.adapter.cwd = () => f.home; },
    'agy environment': f => {
      const env = f.adapter.agyEnv();
      f.adapter.agyEnv = () => ({ ...env, AGY_TEST_SETTING: 'changed' });
    },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const f = fixture(t);
    assert.equal((await f.chat()).ok, true);
    change(f);
    const brief = f.brief ?? BRIEF;
    assert.equal((await f.chat(brief)).ok, true);
    assert.equal(arg(f.calls[1], '--conversation'), undefined);
    assert.equal(arg(f.calls[1], '-p'), full(brief));
    assert.equal((await f.chat(brief)).ok, true);
    assert.equal(arg(f.calls[2], '--conversation'), 'session-2');
    assert.equal(arg(f.calls[2], '-p'), TURN);
    assert.equal(f.calls.length, 3);
  });
});

test('inherited environment changes also invalidate identity without retaining its values', async t => {
  const f = fixture(t), key = 'AI_CHATROOM_GEMINI_TEST_CONTEXT';
  const previous = process.env[key];
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  process.env[key] = 'first-private-value';
  await f.chat();
  process.env[key] = 'second-private-value';
  await f.chat();
  assert.equal(arg(f.calls[1], '--conversation'), undefined);
  assert.equal(arg(f.calls[1], '-p'), full());
  assert.ok(!JSON.stringify(f.adapter.sessions).includes('private-value'));
});

test('JSON envelope, model action, process and spawn failures invalidate before the next call', async t => {
  const cases = [
    ['nonzero exit with usable-looking output', { code: 7, stderr: 'quota exhausted' }, 'exit=7 quota exhausted'],
    ['nonzero exit with a denied-tool pass', { code: 3, stderr: 'process failed',
      reply: { response: '', denied_actions: [{ display_name: 'view_file' }] } }, 'exit=3 process failed\nagy tool denied: view_file'],
    ['reported provider failure', { reply: { status: 'ERROR' }, stderr: 'provider details' }, 'exit=0 provider details\nstatus=ERROR'],
    ['truncated stderr', { code: 1, stderr: 'x'.repeat(700) }, `exit=1 ${'x'.repeat(600)}`],
    ['spawn throw', { throw: 'spawn failed' }, 'exit=-1 Error: spawn failed'],
    ['spawn error event', { childError: 'spawn ENOENT', code: null }, 'exit=null Error: spawn ENOENT'],
    ['invalid envelope JSON', { stdout: 'not JSON' }, /invalid agy JSON response/],
    ['unwrapped action', { stdout: ACTION }, /Unsuccessful agy response/],
    ['null envelope', { json: null }, /Unsuccessful agy response/],
    ['array envelope', { json: [] }, /Unsuccessful agy response/],
    ['missing success status', { reply: { status: undefined } }, /Unsuccessful agy response/],
    ['non-string model response', { reply: { response: { action: 'pass' } } }, /Invalid agy response text/],
    ['null model response', { reply: { response: null } }, /Invalid agy response text/],
    ['empty model response', { reply: { response: '  ' } }, /invalid agy chat action/],
    ['missing model response', { reply: { response: undefined } }, /invalid agy chat action/],
    ['malformed model action', { reply: { response: '{"action":' } }, /invalid agy chat action/],
    ['non-action JSON', { reply: { response: '{"unrelated":"object"}' } }, /invalid agy chat action/],
    ['prose model response', { reply: { response: 'just chatting' } }, /invalid agy chat action/],
    ['malformed denied actions', { reply: { response: '', denied_actions: [null] } }, /invalid agy chat action/],
  ];
  for (const [name, failure, expected] of cases) await t.test(name, async t => {
    const f = fixture(t);
    await f.chat();
    f.queue.push(failure);
    const failed = await f.chat();
    assert.equal(failed.ok, false);
    assert.equal(failed.text, '');
    if (typeof expected === 'string') assert.equal(failed.detail, expected);
    else assert.match(failed.detail, expected);
    assert.equal(f.adapter.sessions.gemini.seed, null);
    assert.equal(f.calls.length, 2, 'failure must not trigger an automatic retry');
    assert.equal((await f.chat()).ok, true);
    assert.equal(arg(f.calls[2], '--conversation'), undefined);
    assert.equal(arg(f.calls[2], '-p'), full());
  });
});

test('a reduced response with a changed, absent or malformed ID fails closed without retry', async t => {
  for (const id of ['other-session', undefined, null, '', '  ', 42, {}]) await t.test(String(id), async t => {
    const f = fixture(t);
    await f.chat();
    f.queue.push({ reply: { conversation_id: id } });
    const result = await f.chat();
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
    assert.match(result.detail, /conversation ID/);
    assert.equal(f.calls.length, 2);
    await f.chat();
    assert.equal(arg(f.calls[2], '--conversation'), undefined);
    assert.equal(arg(f.calls[2], '-p'), full());
  });
});

test('a full-brief success without a conversation ID is usable but never seeds reuse', async t => {
  const f = fixture(t);
  f.queue.push({ reply: { conversation_id: undefined } });
  assert.equal((await f.chat()).ok, true);
  assert.equal(f.adapter.sessions.gemini.seed, null);
  await f.chat();
  assert.equal(arg(f.calls[1], '--conversation'), undefined);
  assert.equal(arg(f.calls[1], '-p'), full());
});

test('successful denied-tool passes and optional character artifacts preserve the room contract', async t => {
  const f = fixture(t);
  const outputs = [
    { response: '', denied_actions: [{ display_name: 'view_file' }] },
    { response: undefined, denied_actions: [{ action: 'read_url' }] },
    { response: `\n\`\`\`json\n${ACTION}\n\`\`\`\n` },
    { response: '{"plan_request":{"title":"tiny house","brief":"cozy"},"useFurniture":[1,2,3]}' },
  ];
  for (const reply of outputs) {
    f.queue.push({ reply });
    const result = await f.chat();
    assert.equal(result.ok, true);
    assert.equal(result.text, reply.response?.trim() ? reply.response : '{"action":"pass"}');
  }
  assert.ok(f.calls.slice(1).every(call => arg(call, '--conversation') === 'session-1'));
});

test('real run timeout discards a late success, preserves diagnostics and forces fresh seeding', async t => {
  const f = fixture(t);
  await f.chat();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.queue.push({ hold: true, stderr: 'still working' });
  const pending = f.chat();
  t.mock.timers.tick(159999);
  assert.equal(running.size, 1);
  t.mock.timers.tick(1); // Existing 150s + 10s process budget.
  f.calls[1].finish();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(result.detail, 'exit=-2 (timeout) still working');
  assert.equal(f.calls.length, 2);
  t.mock.timers.reset();
  await f.chat();
  assert.equal(arg(f.calls[2], '--conversation'), undefined);
  assert.equal(arg(f.calls[2], '-p'), full());
});

test('boost and photo calls always carry a full brief and preserve a successful normal seed', async t => {
  const f = fixture(t);
  await f.chat();
  const seed = structuredClone(f.adapter.sessions.gemini.seed);
  const photo = path.join(f.home, 'reference.PNG');
  fs.writeFileSync(photo, 'mock image bytes');
  const options = [{ boost: true }, { images: [photo] }, { boost: true, images: [photo] }, { images: [path.join(f.home, 'missing.png')] }];
  for (const opts of options) {
    f.queue.push({ hold: true });
    const pending = f.chat(BRIEF, TURN, opts);
    const call = f.calls.at(-1);
    assert.equal(arg(call, '--conversation'), undefined);
    assert.ok(arg(call, '-p').startsWith(full()));
    assert.equal(arg(call, '--model'), opts.boost ? 'gemini-3.8-flash-high' : 'gemini-3.8-flash-medium');
    assert.equal(arg(call, '--print-timeout'), opts.boost ? '240s' : '150s');
    const hasPhoto = opts.images?.includes(photo);
    if (hasPhoto) {
      assert.equal(path.dirname(call.opts.cwd), path.join(f.home, 'data', 'view', 'gemini'));
      assert.deepEqual(fs.readdirSync(call.opts.cwd), ['photo1.png']);
      assert.equal(fs.readFileSync(path.join(call.opts.cwd, 'photo1.png'), 'utf8'), 'mock image bytes');
      assert.match(arg(call, '-p'), /photo1\.png/);
    }
    call.finish();
    assert.equal((await pending).ok, true);
    if (hasPhoto) assert.equal(fs.existsSync(call.opts.cwd), false);
    assert.deepEqual(f.adapter.sessions.gemini.seed, seed);
  }
  await f.chat();
  assert.equal(arg(f.calls.at(-1), '--conversation'), 'session-1');
  assert.equal(arg(f.calls.at(-1), '-p'), TURN);
  assert.equal(f.adapter.sessions.gemini.seed.n, 2);
});

test('failed isolated calls also invalidate normal reuse and clean up photo copies', async t => {
  for (const kind of ['boost', 'photo']) await t.test(kind, async t => {
    const f = fixture(t);
    await f.chat();
    const photo = path.join(f.home, 'photo.png');
    fs.writeFileSync(photo, 'mock image');
    f.queue.push({ stdout: 'invalid JSON' });
    const result = await f.chat(BRIEF, TURN, kind === 'boost' ? { boost: true } : { images: [photo] });
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 2);
    if (kind === 'photo') assert.equal(fs.existsSync(f.calls[1].opts.cwd), false);
    await f.chat();
    assert.equal(arg(f.calls[2], '--conversation'), undefined);
    assert.equal(arg(f.calls[2], '-p'), full());
  });
});

test('preparation and photo-copy errors invalidate even before a process starts', async t => {
  for (const phase of ['cwd', 'environment', 'photo-copy', 'photo-cleanup']) await t.test(phase, async t => {
    const f = fixture(t);
    await f.chat();
    let opts = {}, restore;
    if (phase === 'cwd' || phase === 'environment') {
      const method = phase === 'cwd' ? 'cwd' : 'agyEnv';
      const original = f.adapter[method];
      f.adapter[method] = () => { throw new Error(`${phase} unavailable`); };
      restore = () => { f.adapter[method] = original; };
    } else {
      const photo = path.join(f.home, 'photo.png');
      fs.writeFileSync(photo, 'mock image');
      opts = { images: [photo] };
      const mocked = t.mock.method(fs, phase === 'photo-copy' ? 'copyFileSync' : 'rmSync', () => {
        throw new Error(`${phase} unavailable`);
      });
      restore = () => mocked.mock.restore();
    }
    const result = await f.chat(BRIEF, TURN, opts);
    assert.equal(result.ok, false);
    assert.match(result.detail, new RegExp(`${phase} unavailable`));
    assert.equal(f.adapter.sessions.gemini.seed, null);
    assert.equal(f.calls.length, phase === 'photo-cleanup' ? 2 : 1);
    restore();
    await f.chat();
    assert.equal(arg(f.calls.at(-1), '--conversation'), undefined);
    assert.equal(arg(f.calls.at(-1), '-p'), full());
  });
});

test('overlapping adapter calls never share an unconfirmed seed or revive state after failure', async t => {
  for (const failLatest of [true, false]) await t.test(`failure in ${failLatest ? 'latest' : 'earlier'} call`, async t => {
    const f = fixture(t);
    await f.chat();
    f.queue.push({ hold: true, ...(failLatest ? {} : { stdout: 'malformed' }) });
    const earlier = f.chat();
    f.queue.push({ hold: true, ...(failLatest ? { stdout: 'malformed' } : {}) });
    const latest = f.chat();
    assert.equal(arg(f.calls[1], '--conversation'), 'session-1');
    assert.equal(arg(f.calls[2], '--conversation'), undefined);
    assert.equal(arg(f.calls[2], '-p'), full());
    f.calls[2].finish();
    assert.equal((await latest).ok, !failLatest);
    f.calls[1].finish();
    assert.equal((await earlier).ok, failLatest);
    assert.equal(f.adapter.sessions.gemini.seed, null);
    await f.chat();
    assert.equal(arg(f.calls[3], '--conversation'), undefined);
    assert.equal(arg(f.calls[3], '-p'), full());
  });
});

test('session state bounds invalid rotation settings and ignores stale completions', () => {
  for (const rotate of [undefined, null, 0, -1, NaN, Infinity, 2.5, '4']) {
    const session = new GeminiSession();
    for (let i = 0; i < 7; i++) {
      const request = session.begin('same', rotate);
      assert.equal(request.id, i === 0 || i === 6 ? null : 'seed');
      session.succeed(request, 'seed');
    }
  }
  const session = new GeminiSession();
  const earlier = session.begin('same', 4), latest = session.begin('same', 4);
  session.succeed(latest, 'new');
  session.succeed(earlier, 'old');
  assert.equal(session.seed.id, 'new');
  const request = session.begin('same', 1);
  assert.equal(request.id, null);
  session.invalidate();
  session.succeed(request, 'late');
  assert.equal(session.seed, null);
});

test('identity uses exact bytes and canonical object keys; timeout flag overrides exit zero', () => {
  assert.equal(geminiIdentity({ brief: BRIEF, env: { B: '2', A: '1' } }), geminiIdentity({ env: { A: '1', B: '2' }, brief: BRIEF }));
  assert.notEqual(geminiIdentity({ brief: BRIEF }), geminiIdentity({ brief: BRIEF.trim() }));
  assert.throws(() => geminiReply({ code: 0, timedOut: true, stderr: '',
    stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: 'same', response: ACTION }) }, { id: 'same' }));
});
