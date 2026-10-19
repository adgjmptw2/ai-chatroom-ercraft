import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { saveImageFile } from '../lib/image-files.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const DATE = new Date(2026, 0, 2, 3, 4, 5);
const STEM = 'images/ERCraft-20260102-030405';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0, 0xff]);

// Exercise only the real image functions. No server, scheduler, browser or provider
// starts, and the shared planner harness requires no extra exports or fake adapters.
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(TESTS, '.image-storage-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), TESTS);
    assert.ok(path.basename(home).startsWith('.image-storage-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const store = new Store(home);
  const posts = [], events = [];
  const agents = Object.fromEntries(['gpt', 'gemini', 'claude'].map((id) => [id, { id, lastImageAt: 0, imageBusy: false }]));
  const context = vm.createContext({
    fs, path, Buffer, Date, store, agents, HOME_DIR: home, shuttingDown: false, room: { running: true },
    cfg: { port: 0, imageCooldownSec: 0 }, world: { blocks: new Map() },
    saveImageFile: (directory, input) => saveImageFile(directory, { ...input, date: DATE }),
    adapters: { image: options.image ?? (() => { throw new Error('Unexpected provider call'); }) },
    shootWorld: options.shot ?? (async () => PNG),
    post: (message) => posts.push(message), broadcast: (type, data) => events.push({ type, data }),
    setStatus: (agent, status) => { agent.status = status; }, pushMembers() {},
    sheetOf() { throw new Error('Unexpected reference lookup'); },
    tx: () => ({
      drawing: (id) => `drawing ${id}`, drawFail: (id) => `draw failed ${id}`,
      shotFail: (id, error) => `shot failed ${id}: ${error}`,
      stickerSaved: (id, rel) => `saved ${id}: ${rel}`, stickerFail: (id, error) => `sticker failed ${id}: ${error}`,
      imgEmpty: 'empty image', imgType: 'invalid image', imgLimit: 'image limit', imgTooBig: () => 'image too big',
    }),
  });
  const names = ['sniffImage', 'saveUpload', 'stickerPath', 'saveSticker', 'takeWorldShot', 'startImage'];
  const functions = names.map((name) => {
    const match = SOURCE.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `Missing server function ${name}`);
    return match[0];
  });
  const limit = SOURCE.match(/^const UPLOAD_MAX_BYTES = [^;]+;/m);
  assert.ok(limit);
  new vm.Script(`${limit[0]}\n${functions.join('\n')}\nglobalThis.harness = { saveUpload, takeWorldShot, startImage };`).runInContext(context);
  return { ...context.harness, home, store, agents, posts, events };
}

test('generated images, world shots and uploads share a same-second namespace and retain owners and bytes', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const files = new Map();
  const h = fixture(t, {
    image: async (id) => { await gate; return { ok: true, file: files.get(id) }; },
    shot: async () => { await gate; return Buffer.concat([PNG, Buffer.from('world')]); },
  });
  const old = `${STEM}.png`;
  fs.mkdirSync(h.store.abs('images'));
  fs.writeFileSync(h.store.abs(old), Buffer.from('existing'));
  h.store.touchMeta(old, 'previous-owner', true);
  const oldMeta = { ...h.store.meta[old] };
  for (const id of ['gpt', 'gemini']) {
    const file = path.join(h.home, `${id}.PNG`);
    fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from(id)]));
    files.set(id, file);
  }
  const pending = [
    h.startImage(h.agents.gpt, { prompt: 'gpt prompt' }),
    h.startImage(h.agents.gemini, { prompt: 'gemini prompt' }),
    h.takeWorldShot('claude', {}),
    gate.then(() => h.saveUpload({ name: 'ignored.svg', data: `data:image/png;base64,${PNG.toString('base64')}` })),
  ];
  release();
  const [, , shot, upload] = await Promise.all(pending);
  assert.equal(h.posts.some((message) => message.kind === 'error'), false);
  const images = h.posts.filter((message) => message.attach);
  assert.equal(images.length, 3);
  const paths = [...images.map((message) => message.attach.path), upload];
  assert.equal(new Set(paths).size, 4);
  assert.deepEqual(paths.sort(), [2, 3, 4, 5].map((i) => `${STEM}-${i}.png`));
  const diskMeta = JSON.parse(fs.readFileSync(h.store.metaFile, 'utf8'));
  for (const message of images) {
    const rel = message.attach.path;
    assert.equal(diskMeta[rel].createdBy, message.from);
    assert.equal(diskMeta[rel].by, message.from);
    const expected = message.from === 'claude' ? Buffer.concat([PNG, Buffer.from('world')]) : fs.readFileSync(files.get(message.from));
    assert.deepEqual(fs.readFileSync(h.store.abs(rel)), expected);
    if (message.from === 'claude') {
      assert.equal(rel, shot);
      assert.equal(message.attach.shot, true);
    } else {
      assert.equal(message.attach.prompt, `${message.from} prompt`);
      assert.equal(h.agents[message.from].imageBusy, false);
    }
  }
  assert.equal(diskMeta[upload].createdBy, 'user');
  assert.equal(diskMeta[upload].by, 'user');
  assert.deepEqual(fs.readFileSync(h.store.abs(upload)), PNG);
  assert.deepEqual(fs.readFileSync(h.store.abs(old)), Buffer.from('existing'));
  assert.deepEqual(diskMeta[old], oldMeta);
  assert.equal(h.events.filter((event) => event.type === 'ws').length, 3);
});

test('generated JPEG keeps its bytes and user-selected sticker saveAs basename', async (t) => {
  let source;
  const h = fixture(t, { image: async () => ({ ok: true, file: source }) });
  source = path.join(h.home, 'provider.JPEG');
  fs.writeFileSync(source, JPEG);
  await h.startImage(h.agents.gpt, { prompt: 'portrait', saveAs: 'stickers/my chosen name.png' });
  assert.equal(h.posts.some((message) => message.kind === 'error'), false);
  const rel = h.posts.find((message) => message.attach).attach.path;
  assert.equal(rel, `${STEM}.jpeg`);
  const sticker = 'stickers/my chosen name.jpeg';
  for (const name of [rel, sticker]) {
    assert.deepEqual(fs.readFileSync(h.store.abs(name)), JPEG);
    assert.equal(h.store.meta[name].by, 'gpt');
    assert.equal(h.store.meta[name].createdBy, 'gpt');
  }
  assert.deepEqual(fs.readFileSync(source), JPEG);
});

test('uploads retain signature-based extensions and validation regardless of the supplied filename', (t) => {
  const h = fixture(t);
  const samples = [
    ['.png', PNG], ['.jpg', JPEG], ['.gif', Buffer.from('GIF89a\0sample')],
    ['.webp', Buffer.from('RIFF\0\0\0\0WEBP\0sample')],
  ];
  for (const [extension, bytes] of samples) {
    const rel = h.saveUpload({ name: 'untrusted.svg', data: bytes.toString('base64') });
    assert.equal(rel, `${STEM}${extension}`);
    assert.deepEqual(fs.readFileSync(h.store.abs(rel)), bytes);
    assert.equal(h.store.meta[rel].by, 'user');
  }
  assert.throws(() => h.saveUpload({ data: '' }), /empty image/);
  assert.throws(() => h.saveUpload({ data: Buffer.from('<svg/>').toString('base64') }), /invalid image/);
  assert.throws(() => h.saveUpload({ data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }), /image too big/);
  assert.equal(h.store.listFiles().length, samples.length);
});
