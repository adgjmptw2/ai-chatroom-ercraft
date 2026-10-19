import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { Adapters, planArgs, running } from '../lib/agents.mjs';

function fakeAdapter(t, { code = 0, text = '{"kind":"house"}', stderr = '', delay = 0, planner = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chatroom-adapter-test-'));
  const invocations = [];
  t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
    invocations.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('finish', () => setTimeout(() => {
      if (text !== null) fs.writeFileSync(args[args.indexOf('-o') + 1], text);
      child.stderr.write(stderr);
      child.stdout.write('this stdout must not become a fallback recipe');
      child.emit('close', code);
    }, delay));
    return child;
  });
  syncBuiltinESMExports();
  // Avoid the production constructor's CLI discovery/version probes entirely.
  const adapter = Object.assign(Object.create(Adapters.prototype), { root: home,
    cfg: { planner, webSearch: true, agents: { gpt: { model: 'other', effort: 'low' } } }, bins: { codex: 'FAKE-CODEX-ONLY' }, sessions: {} });
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(path.dirname(home), os.tmpdir());
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { adapter, invocations, home };
}

test('planArgs hardcodes exact model/effort, isolates config, disables tools/web, and preserves the existing base-url override', () => {
  const cfg = { codexBaseUrl: 'http://localhost:9999/v1', webSearch: true,
    planner: { model: 'wrong', effort: 'low' }, agents: { gpt: { model: 'wrong', boost: { model: 'also-wrong' } } } };
  const args = planArgs(cfg, 'recipe.txt');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-astra');
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  for (const flag of ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.ok(args.includes('openai_base_url="http://localhost:9999/v1"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('mcp_servers={}'));
  for (const feature of ['shell_tool', 'computer_use', 'browser_use', 'apps', 'plugins', 'image_generation', 'multi_agent', 'view_image', 'code_mode_host']) {
    assert.equal(args[args.indexOf(feature) - 1], '--disable');
  }
  assert.equal(args.at(-1), '-');
  assert.ok(!args.some((a) => a.includes('wrong')));
  assert.ok(!planArgs({}, 'out').some((a) => a.startsWith('openai_base_url=')));
});

test('dedicated planner call uses fresh scratch folders and a bounded private log', async (t) => {
  const f = fakeAdapter(t, { stderr: 'x'.repeat(20000) });
  const a = await f.adapter.plan('설계 JSON 하나');
  const b = await f.adapter.plan('설계 JSON 둘');
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(a.text, '{"kind":"house"}');
  assert.equal(f.invocations.length, 2);
  const [first, second] = f.invocations;
  assert.notEqual(first.opts.cwd, second.opts.cwd);
  assert.equal(path.dirname(first.opts.cwd), path.join(f.home, 'data', 'cwd', 'planner'));
  assert.ok(!fs.existsSync(first.opts.cwd));
  assert.deepEqual(f.adapter.sessions, {});
  const logs = fs.readFileSync(path.join(f.home, 'data', 'logs', 'planner.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => l.detail.length < 3300));
  assert.equal(running.size, 0);
});

test('failure and missing/oversized files never fall back to stdout, a member or another call', async (t) => {
  for (const options of [{ code: 1, stderr: 'gpt-6-astra provider secret' }, { text: null }, { text: 'x'.repeat(32769) }]) {
    await t.test(JSON.stringify(options).slice(0, 60), async (t) => {
      const f = fakeAdapter(t, options);
      const result = await f.adapter.plan('설계');
      assert.equal(result.ok, false);
      assert.equal(result.text, '');
      assert.ok(!JSON.stringify(result).includes('astra'));
      assert.equal(f.invocations.length, 1);
    });
  }
});

test('adapter timeout returns a failure after one call and never uses the late file', async (t) => {
  const f = fakeAdapter(t, { delay: 30, planner: { timeoutSec: 0.001 } });
  const result = await f.adapter.plan('설계');
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(f.invocations.length, 1);
  assert.match(result.detail, /초과/);
});

test('invalid adapter input is rejected before any child process starts', async (t) => {
  const f = fakeAdapter(t);
  for (const prompt of ['', null, 'x'.repeat(24001)]) assert.equal((await f.adapter.plan(prompt)).ok, false);
  f.adapter.cfg.planner.timeoutSec = 601;
  assert.equal((await f.adapter.plan('설계')).ok, false);
  assert.equal(f.invocations.length, 0);
});
