import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

test('state checkpoint failures preserve the last complete state, corrupt state fails closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-state-durable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root); store.state = { room: { running: true, sleeping: false } }; store.saveState();
  const original = fs.readFileSync(store.stateFile, 'utf8');
  store.state.room.running = false;
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('disk failure'); });
  assert.throws(() => store.saveState(), /disk failure/);
  assert.equal(fs.readFileSync(store.stateFile, 'utf8'), original);
  rename.mock.restore();
  assert.equal(new Store(root).state.room.running, true);
  fs.writeFileSync(store.stateFile, '{broken');
  assert.throws(() => new Store(root));
  assert.equal(fs.readFileSync(store.stateFile, 'utf8'), '{broken');
});
