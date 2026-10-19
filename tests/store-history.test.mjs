import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { MAX_RECENT_MESSAGES, MAX_HISTORY_PAGE, HISTORY_CHUNK_BYTES } from '../lib/chat-history.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const message = (id, extra = {}) => ({ id, ts: id, from: 'user', text: `message ${id}`, ...extra });
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

function fixture(t, contents = '') {
  const home = fs.mkdtempSync(path.join(TESTS, '.store-history-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), TESTS);
    assert.ok(path.basename(home).startsWith('.store-history-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const file = path.join(home, 'data', 'messages.jsonl');
  fs.mkdirSync(path.dirname(file));
  if (contents !== '') fs.writeFileSync(file, contents);
  return { home, file };
}

const ids = (messages) => messages.map((msg) => msg.id);

test('startup keeps only the last contiguous 2000 messages and streams every record', async (t) => {
  const records = [message(50000), ...Array.from({ length: 12000 }, (_, i) => message(i + 1))];
  const { home, file } = fixture(t, jsonl(records));
  const original = fs.readFileSync(file);
  const readFileSync = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'readFileSync', (name, ...args) => {
    assert.notEqual(name, file, 'the JSONL log must not be readFileSync-ed');
    return readFileSync(name, ...args);
  });
  const readSync = fs.readSync.bind(fs);
  let reads = 0;
  const readMock = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    assert.ok(length <= HISTORY_CHUNK_BYTES, 'bounded read size');
    reads++;
    return readSync(fd, buffer, offset, length, position);
  });
  // Observe peak collection sizes during replay, not just after construction.
  const set = Map.prototype.set;
  let peak = 0;
  const mapMock = t.mock.method(Map.prototype, 'set', function (key, value) {
    const result = set.call(this, key, value);
    if (value?.from === 'user' && value.id === key) peak = Math.max(peak, this.size);
    return result;
  });
  const store = new Store(home);
  mapMock.mock.restore();
  assert.equal(store.messages.length, MAX_RECENT_MESSAGES);
  assert.equal(store.byId.size, MAX_RECENT_MESSAGES);
  assert.ok(peak <= MAX_RECENT_MESSAGES);
  assert.ok(reads > 1);
  assert.deepEqual(ids(store.messages), records.slice(-MAX_RECENT_MESSAGES).map((msg) => msg.id));
  assert.equal(store.byId.has(50000), false);
  assert.equal(store.nextId, 50001, 'ID high-water mark includes already evicted records');
  assert.equal(store.lastId, 50000);
  assert.deepEqual(await store.historyBefore(3), [message(1, { reactions: {} }), message(2, { reactions: {} })]);
  readMock.mock.restore();
  assert.deepEqual(readFileSync(file), original, 'startup and page reads preserve every original byte');
  const started = performance.now();
  new Store(home);
  const elapsed = performance.now() - started;
  t.diagnostic(`Synchronous startup scanned ${original.length} bytes / ${records.length} records in ${elapsed.toFixed(1)} ms (fixture only).`);
});

test('live growth is bounded and existing synchronous message APIs retain object identity', (t) => {
  const { home } = fixture(t);
  const store = new Store(home);
  const messagesReference = store.messages, mapReference = store.byId;
  let last;
  for (let i = 0; i < 2205; i++) {
    last = store.addMessage({ from: 'user', text: `live ${i}` });
    assert.ok(!(last instanceof Promise));
    assert.ok(store.messages.length <= MAX_RECENT_MESSAGES);
    assert.equal(store.byId.size, store.messages.length);
  }
  assert.equal(store.messages, messagesReference);
  assert.equal(store.byId, mapReference);
  assert.equal(store.messages[0].id, 206);
  assert.equal(store.byId.has(205), false);
  assert.equal(store.lastMessage(), last);
  assert.equal(store.getMessage(last.id), last);
  assert.deepEqual(ids(store.recent(2)), [2204, 2205]);
  assert.deepEqual(ids(store.after(2203)), [2204, 2205]);
  assert.equal(store.after(0).length, MAX_RECENT_MESSAGES);
  assert.equal(store.lastId, 2205);
  store.loadMessages();
  assert.equal(store.messages.length, MAX_RECENT_MESSAGES, 'reload does not duplicate cached entries');
  assert.equal(store.addMessage({ from: 'user', text: 'after reload' }).id, 2206);
});

test('disk pages cross the ring boundary without gaps and replay late overlays through EOF', async (t) => {
  const records = Array.from({ length: 625 }, (_, i) => message(i + 1,
    i === 4 ? { attach: { path: 'photos/한글.png', desc: 'initial' }, reactions: { '👍': ['a'] } } : {}));
  records.splice(20, 0, { kind: 'react', target: 5, by: 'early', emoji: '🌷' });
  records.push(
    { kind: 'react', target: 5, by: 'a', emoji: '👍' },
    { kind: 'react', target: 5, by: 'late', emoji: '👍' },
    { kind: 'desc', target: 5, text: 'first late description' },
    { kind: 'desc', target: 5, text: '마지막 묘사 🐱' },
    { kind: 'react', target: 624, by: 'new', emoji: '💚' },
  );
  const { home, file } = fixture(t, jsonl(records));
  const original = fs.readFileSync(file);
  const store = new Store(home, { maxMessages: 10 });
  const pages = [];
  let before = Infinity;
  for (;;) {
    const page = await store.historyBefore(before, 1000);
    if (!page.length) break;
    assert.ok(page.length <= MAX_HISTORY_PAGE);
    pages.unshift(...page);
    before = page[0].id;
  }
  assert.deepEqual(ids(pages), Array.from({ length: 625 }, (_, i) => i + 1));
  assert.deepEqual(pages[4].reactions, { '👍': ['a', 'late'], '🌷': ['early'] });
  assert.equal(pages[4].attach.desc, '마지막 묘사 🐱');
  assert.deepEqual(store.byId.get(624).reactions, { '💚': ['new'] });
  assert.equal(store.byId.has(5), false);
  assert.equal(store.messages.length, 10);
  assert.equal(store.byId.size, 10);
  assert.deepEqual(fs.readFileSync(file), original);
});

test('old synchronous lookups and mutations preserve overlays without growing the cache', async (t) => {
  const records = Array.from({ length: 12 }, (_, i) => message(i + 1,
    i === 0 || i === 2 ? { attach: { path: 'photos/old.png' } } : {}));
  const { home, file } = fixture(t, jsonl(records));
  const store = new Store(home, { maxMessages: 3 });
  assert.equal(store.getMessageByAttachment('photos/old.png').id, 3, 'latest matching attachment');
  assert.equal(store.getMessage(1).text, 'message 1');
  assert.equal(store.getMessage(999), null);
  assert.equal(store.getMessage('1'), null);
  assert.equal(store.getMessageByAttachment('absent.png'), null);
  const reacted = store.applyReaction(1, 'claude', '👍');
  assert.equal(reacted.id, 1);
  assert.ok(!(reacted instanceof Promise));
  assert.deepEqual(reacted.reactions, { '👍': ['claude'] });
  const afterFirstReaction = fs.readFileSync(file);
  assert.equal(store.applyReaction(1, 'claude', '👍'), null);
  assert.deepEqual(fs.readFileSync(file), afterFirstReaction, 'duplicate old reaction is not appended');
  assert.equal(store.setAttachDesc(3, 'late description').attach.desc, 'late description');
  assert.equal(store.getMessageByAttachment('photos/old.png').attach.desc, 'late description');
  assert.equal(store.applyReaction(999, 'claude', '👍'), null);
  assert.equal(store.setAttachDesc(12, 'no attachment'), null);
  assert.deepEqual(ids(store.messages), [10, 11, 12]);
  assert.equal(store.byId.size, 3);
  const restart = new Store(home, { maxMessages: 3 });
  assert.equal(restart.nextId, 13, 'overlay records do not allocate message IDs');
  const history = await restart.historyBefore(4);
  assert.deepEqual(history[0].reactions, { '👍': ['claude'] });
  assert.equal(history[2].attach.desc, 'late description');
});

test('UTF-8 records split across chunks and records larger than a chunk remain exact', async (t) => {
  // Put a 4-byte codepoint one byte before the first chunk boundary.
  const prefix = '{"id":1,"from":"user","text":"';
  const text = 'x'.repeat(HISTORY_CHUNK_BYTES - Buffer.byteLength(prefix) - 1) + '🐱한글日本語' + '끝'.repeat(HISTORY_CHUNK_BYTES);
  const contents = `${prefix}${text}"}\r\n${JSON.stringify(message(2, { text: '둘 🐱' }))}`;
  const { home, file } = fixture(t, contents);
  const original = fs.readFileSync(file);
  const store = new Store(home, { maxMessages: 1 });
  assert.equal(store.getMessage(1).text, text);
  const page = await store.historyBefore();
  assert.equal(page[0].text, text);
  assert.equal(page[1].text, '둘 🐱');
  assert.equal(store.historyDiagnostics.invalidRecords, 0);
  assert.deepEqual(fs.readFileSync(file), original);
});

test('valid unterminated JSONL is unchanged on reads and receives only an appended separator', async (t) => {
  const contents = JSON.stringify(message(7, { attach: { path: 'old.png' } }));
  const { home, file } = fixture(t, contents);
  const store = new Store(home);
  assert.equal(store.nextId, 8);
  assert.equal((await store.historyBefore())[0].id, 7);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  const msg = store.addMessage({ text: 'new' });
  assert.equal(msg.id, 8);
  assert.equal(fs.readFileSync(file, 'utf8'), contents + '\n' + JSON.stringify(msg) + '\n');
  const restart = new Store(home);
  assert.deepEqual(ids(restart.messages), [7, 8]);
  assert.equal(restart.nextId, 9);
});

test('unterminated final overlay is replayed and remains separate from a subsequent overlay', async (t) => {
  const contents = jsonl([message(1, { attach: { path: 'one.png' } })])
    + JSON.stringify({ kind: 'react', target: 1, by: 'a', emoji: '👍' });
  const { home, file } = fixture(t, contents);
  const store = new Store(home);
  assert.deepEqual(store.lastMessage().reactions, { '👍': ['a'] });
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  store.setAttachDesc(1, 'updated');
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(contents + '\n'));
  const restarted = new Store(home);
  assert.equal(restarted.nextId, 2);
  assert.equal((await restarted.historyBefore())[0].attach.desc, 'updated');
});

test('malformed interior records are reported, cannot poison IDs, and remain byte-for-byte intact', async (t) => {
  const contents = jsonl([message(9)]) + 'not json\nnull\n42\n[]\n{"id":"bad"}\n'
    + jsonl([message(3), { kind: 'react', target: 3, by: 'a', emoji: '👍', id: 20 }]);
  const { home, file } = fixture(t, contents);
  const warning = t.mock.method(process, 'emitWarning', () => {});
  const store = new Store(home, { maxMessages: 1 });
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(warning.mock.calls[0].arguments[1].code, 'HISTORY_INVALID_RECORDS');
  assert.equal(store.historyDiagnostics.invalidRecords, 5);
  assert.equal(store.historyDiagnostics.incompleteTail, false);
  assert.equal(store.historyDiagnostics.firstInvalidOffset, Buffer.byteLength(jsonl([message(9)])));
  assert.equal(store.nextId, 21);
  assert.deepEqual(ids(await store.historyBefore()), [9, 3]);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  assert.equal(store.addMessage({ text: 'safe after terminated damage' }).id, 21);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(contents));
});

test('partial final bytes are reported and block writes without losing bytes or advancing IDs', async (t) => {
  const contents = jsonl([message(4, { attach: { path: 'old.png' } })]) + '{"id":5,"text":"interrupted';
  const { home, file } = fixture(t, contents);
  const warning = t.mock.method(process, 'emitWarning', () => {});
  const store = new Store(home);
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(store.historyDiagnostics.incompleteTail, true);
  assert.deepEqual(ids(await store.historyBefore()), [4]);
  assert.throws(() => store.addMessage({ text: 'new' }), { code: 'HISTORY_INCOMPLETE_TAIL' });
  assert.throws(() => store.applyReaction(4, 'a', '👍'), { code: 'HISTORY_INCOMPLETE_TAIL' });
  assert.throws(() => store.setAttachDesc(4, 'new'), { code: 'HISTORY_INCOMPLETE_TAIL' });
  assert.equal(store.nextId, 5);
  assert.deepEqual(store.lastMessage().reactions, {});
  assert.equal(store.lastMessage().attach.desc, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  // Recovery is deliberate and append-only: finish the interrupted record.
  fs.appendFileSync(file, '"}\n');
  const recovered = new Store(home);
  assert.deepEqual(ids(recovered.messages), [4, 5]);
  assert.equal(recovered.addMessage({ text: 'recovered' }).id, 6);
});

test('append failures never acknowledge a message, overlay, or ID advancement', (t) => {
  const { home, file } = fixture(t, jsonl([message(1, { attach: { path: 'one.png' } })]));
  const store = new Store(home);
  const original = fs.readFileSync(file);
  const append = t.mock.method(fs, 'appendFileSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  assert.throws(() => store.addMessage({ text: 'not stored' }), { code: 'ENOSPC' });
  assert.throws(() => store.applyReaction(1, 'a', '👍'), { code: 'ENOSPC' });
  assert.throws(() => store.setAttachDesc(1, 'not stored'), { code: 'ENOSPC' });
  assert.equal(store.nextId, 2);
  assert.deepEqual(ids(store.messages), [1]);
  assert.equal(store.byId.size, 1);
  assert.deepEqual(store.lastMessage().reactions, {});
  assert.equal(store.lastMessage().attach.desc, undefined);
  assert.deepEqual(fs.readFileSync(file), original);
  append.mock.restore();
  const restarted = new Store(home);
  assert.equal(restarted.addMessage({ text: 'stored' }).id, 2);
});

test('partial append failure is preserved and detected both immediately and on restart', async (t) => {
  const { home, file } = fixture(t, jsonl([message(1)]));
  const store = new Store(home);
  const original = fs.readFileSync(file);
  const appendFileSync = fs.appendFileSync.bind(fs);
  const append = t.mock.method(fs, 'appendFileSync', (name, data) => {
    appendFileSync(name, data.slice(0, 15));
    throw Object.assign(new Error('short append'), { code: 'ENOSPC' });
  });
  assert.throws(() => store.addMessage({ text: 'interrupted' }), { code: 'ENOSPC' });
  append.mock.restore();
  assert.equal(store.nextId, 2);
  assert.equal(store.messages.length, 1);
  const damaged = fs.readFileSync(file);
  assert.deepEqual(damaged.subarray(0, original.length), original);
  assert.throws(() => store.addMessage({ text: 'do not concatenate onto damage' }), { code: 'HISTORY_CHANGED' });
  t.mock.method(process, 'emitWarning', () => {});
  const restarted = new Store(home);
  assert.equal(restarted.historyDiagnostics.incompleteTail, true);
  assert.throws(() => restarted.addMessage({ text: 'blocked' }), { code: 'HISTORY_INCOMPLETE_TAIL' });
  assert.deepEqual(ids(await restarted.historyBefore()), [1]);
  assert.deepEqual(fs.readFileSync(file), damaged);
});

test('history scan guard rejects overlap, releases on failure, and returns detached snapshots', async (t) => {
  const { home } = fixture(t, jsonl([message(1), message(2)]));
  const store = new Store(home);
  const pending = store.historyBefore();
  await assert.rejects(store.historyBefore(), { code: 'HISTORY_BUSY' });
  const first = await pending;
  first[0].text = 'external edit';
  assert.equal(store.getMessage(1).text, 'message 1');
  assert.equal((await store.historyBefore())[0].text, 'message 1');
  const open = t.mock.method(fs.promises, 'open', async () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
  await assert.rejects(store.historyBefore(), { code: 'EACCES' });
  open.mock.restore();
  assert.deepEqual(ids(await store.historyBefore()), [1, 2]);
});

test('async history snapshots EOF and allows appends while scanning', async (t) => {
  const { home } = fixture(t, jsonl(Array.from({ length: 2500 }, (_, i) => message(i + 1))));
  const store = new Store(home, { maxMessages: 10 });
  const open = fs.promises.open.bind(fs.promises);
  let appended = false, reads = 0;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      reads++;
      if (!appended) {
        appended = true;
        store.addMessage({ text: 'during scan' });
        store.applyReaction(5, 'late', '👍');
      }
      return read(...readArgs);
    };
    return handle;
  });
  const page = await store.historyBefore();
  assert.ok(reads > 1, 'awaited chunk reads yield between chunks');
  assert.equal(page.at(-1).id, 2500);
  assert.equal(store.lastMessage().id, 2501);
  assert.equal((await store.historyBefore()).at(-1).id, 2501);
  assert.deepEqual((await store.historyBefore(6, 1))[0].reactions, { '👍': ['late'] });
});

test('cursor/limit edge cases, absent logs, and cache capacity validation are bounded', async (t) => {
  const { home, file } = fixture(t);
  const store = new Store(home);
  assert.deepEqual(await store.historyBefore(), []);
  assert.equal(fs.existsSync(file), false, 'read-only history does not create a log');
  assert.deepEqual(await store.historyBefore(1), []);
  await assert.rejects(store.historyBefore('bad'), TypeError);
  await assert.rejects(store.historyBefore(Infinity, NaN), TypeError);
  for (let i = 0; i < 5; i++) store.addMessage({ text: 'edge' });
  assert.deepEqual(ids(await store.historyBefore(4, 2)), [2, 3]);
  assert.deepEqual(ids(await store.historyBefore('4', 2.8)), [2, 3]);
  assert.deepEqual(await store.historyBefore(Infinity, -1), []);
  assert.deepEqual(await store.historyBefore(Infinity, 0), []);
  assert.equal((await store.historyBefore(Infinity, Infinity)).length, 5);
  for (const maxMessages of [0, -1, 1.5, 2001, Infinity, NaN]) {
    assert.throws(() => new Store(home, { maxMessages }), RangeError);
  }
});

test('duplicate IDs cannot evict the latest mapped object and unsafe IDs cannot be allocated', (t) => {
  const { home } = fixture(t, jsonl([message(1), message(1, { text: 'newer' }), message(2)]));
  const store = new Store(home, { maxMessages: 2 });
  assert.equal(store.getMessage(1).text, 'newer');
  assert.equal(store.byId.size, 2);
  store.addMessage({ text: 'next' });
  assert.equal(store.byId.has(1), false);
  const { home: exhaustedHome, file } = fixture(t, jsonl([message(Number.MAX_SAFE_INTEGER)]));
  const exhausted = new Store(exhaustedHome);
  const before = fs.readFileSync(file);
  assert.throws(() => exhausted.addMessage({ text: 'unsafe id' }), RangeError);
  assert.deepEqual(fs.readFileSync(file), before);
});
