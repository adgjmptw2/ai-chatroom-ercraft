import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { saveImageFile } from '../lib/image-files.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const DATE = new Date(2026, 0, 2, 3, 4, 5);
const STEM = 'ERCraft-20260102-030405';
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 1, 2]);

function fixture(t, beforeCleanup = () => {}) {
  const home = fs.mkdtempSync(path.join(TESTS, '.image-files-'));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(path.dirname(path.resolve(home)), TESTS);
    assert.ok(path.basename(home).startsWith('.image-files-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('fixed ERCraft names use padded local time and only safe lowercase image extensions', (t) => {
  const directory = path.join(fixture(t), 'images');
  for (const extension of ['.JPG', '.JPEG', '.PNG', '.WEBP', '.GIF']) {
    const name = saveImageFile(directory, { data: BYTES, extension, date: DATE });
    assert.equal(name, `${STEM}${extension.toLowerCase()}`);
    assert.deepEqual(fs.readFileSync(path.join(directory, name)), BYTES);
  }
});

test('copies preserve source bytes and extension, including the existing extensionless PNG default', (t) => {
  const home = fixture(t);
  for (const extension of ['.JPG', '.JPEG', '.PNG', '.WEBP', '.GIF', '']) {
    const source = path.join(home, `provider-output${extension}`);
    fs.writeFileSync(source, BYTES);
    const directory = path.join(home, `images${extension || '-default'}`);
    const name = saveImageFile(directory, { source, date: DATE });
    assert.equal(name, `${STEM}${extension.toLowerCase() || '.png'}`);
    assert.deepEqual(fs.readFileSync(path.join(directory, name)), BYTES);
    assert.deepEqual(fs.readFileSync(source), BYTES);
  }
});

test('unsafe extensions and ambiguous input are rejected before creating files', (t) => {
  const directory = path.join(fixture(t), 'images');
  for (const extension of ['.svg', '.exe', '../escape.png', '.png/escape', '.jpg?x', '']) {
    assert.throws(() => saveImageFile(directory, { data: BYTES, extension, date: DATE }), /Unsupported image extension/);
  }
  assert.throws(() => saveImageFile(directory, {}), /either image data or a source file/);
  assert.throws(() => saveImageFile(directory, { data: BYTES, source: 'unused.png' }), /either image data or a source file/);
  assert.equal(fs.existsSync(directory), false);
});

test('same-second retries keep the whole timestamp and never replace earlier buffer or copy contents', (t) => {
  const home = fixture(t);
  const directory = path.join(home, 'images');
  const expected = new Map();
  for (let i = 1; i <= 12; i++) {
    const bytes = Buffer.concat([BYTES, Buffer.from(`image-${i}`)]);
    const source = path.join(home, `provider-${i}.png`);
    fs.writeFileSync(source, bytes);
    const name = saveImageFile(directory, { ...(i % 2 ? { data: bytes } : { source }), date: DATE });
    assert.equal(name, `${STEM}${i === 1 ? '' : `-${i}`}.png`);
    expected.set(name, bytes);
  }
  for (const [name, bytes] of expected) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
});

test('non-collision filesystem errors propagate without consuming a filename', (t) => {
  const home = fixture(t);
  const directory = path.join(home, 'images');
  assert.throws(() => saveImageFile(directory, { source: path.join(home, 'missing.png'), date: DATE }), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(saveImageFile(directory, { data: BYTES, date: DATE }), `${STEM}.png`);
});

test('simultaneous worker copies and buffer writes reserve distinct names without overwriting', { timeout: 30000 }, async (t) => {
  const workers = [];
  const home = fixture(t, async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const directory = path.join(home, 'images');
  fs.mkdirSync(directory);
  const original = Buffer.from('pre-existing image');
  fs.writeFileSync(path.join(directory, `${STEM}.png`), original);
  fs.writeFileSync(path.join(directory, `${STEM}-2.png`), original);
  const gate = new SharedArrayBuffer(4);
  const count = 16;
  const jobs = Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.concat([BYTES, Buffer.alloc(32768, i), Buffer.from(`provider-${i}`)]);
    const source = path.join(home, `provider-${i}.png`);
    fs.writeFileSync(source, bytes);
    const worker = new Worker(`
      const { parentPort, workerData: d } = require('node:worker_threads');
      (async () => {
        const { saveImageFile } = await import(d.helper);
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(d.gate), 0, 0);
        const name = saveImageFile(d.directory, {
          ...(d.copy ? { source: d.source } : { data: Buffer.from(d.bytes) }),
          date: new Date(d.date),
        });
        parentPort.postMessage({ name });
      })().catch((error) => { throw error; });
    `, { eval: true, workerData: {
      helper: new URL('../lib/image-files.mjs', import.meta.url).href,
      directory, source, bytes, copy: i % 2 === 0, date: DATE.getTime(), gate,
    } });
    workers.push(worker);
    let markReady, failReady, finish, fail;
    const ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject; });
    const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    // Attach a rejection handler immediately; results are awaited after the barrier.
    done.catch(() => {});
    let name;
    worker.on('message', (message) => {
      if (message.ready) markReady();
      if (message.name) name = message.name;
    });
    worker.on('error', (error) => { failReady(error); fail(error); });
    worker.on('exit', (code) => {
      if (code !== 0 || !name) {
        const error = new Error(`Image worker exited ${code} without a saved filename`);
        failReady(error); fail(error);
      } else finish({ name, bytes, source });
    });
    return { ready, done };
  });
  await Promise.all(jobs.map((job) => job.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, count);
  const results = await Promise.all(jobs.map((job) => job.done));
  assert.equal(new Set(results.map(({ name }) => name)).size, count);
  assert.deepEqual(results.map(({ name }) => name).sort(), Array.from({ length: count }, (_, i) => `${STEM}-${i + 3}.png`).sort());
  for (const { name, bytes, source } of results) {
    assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
    assert.deepEqual(fs.readFileSync(source), bytes);
  }
  for (const suffix of ['', '-2']) assert.deepEqual(fs.readFileSync(path.join(directory, `${STEM}${suffix}.png`)), original);
  assert.equal(fs.readdirSync(directory).length, count + 2);
});
