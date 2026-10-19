import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageMonitor } from '../lib/usage.mjs';

test('usage replay preserves bytes and bounds cache even with corrupt or oversized records', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'));
  const now = Date.now(), file = path.join(root, 'data/usage.jsonl');
  const rows = [JSON.stringify({ at: 1, id: 'gpt', w: { week: 1 } }), 'invalid', 'x'.repeat(70000)];
  for (let i = 0; i < 5000; i++) rows.push(JSON.stringify({ at: now + i, id: 'gpt', w: { week: i }, snap: { windows: [], note: '테스트' } }));
  const original = rows.join('\n') + '\n'; fs.writeFileSync(file, original);
  const usage = new UsageMonitor(root, {});
  assert.equal(usage.hist.gpt.length, 4096);
  assert.equal(usage.hist.gpt.at(-1).w.week, 4999);
  assert.equal(usage.latest.gpt.note, '테스트');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
