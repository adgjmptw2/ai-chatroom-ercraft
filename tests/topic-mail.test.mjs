import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicStore } from '../lib/topics.mjs';
import { deliverTopicMail } from '../lib/topic-mail.mjs';

const input = { title: '합성 이야기', text: '함께 간식을 골라 보는 이야기', sourceUrl: 'https://example.invalid/story', consent: true };
const formId = 'testform';
const reply = (ok = true, body = { ok: true }) => ({ ok, json: async () => body });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-topic-mail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Any accidentally uninjected request fails locally instead of sending an email.
  const unexpectedFetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Real network forbidden'); });
  t.after(() => assert.equal(unexpectedFetch.mock.callCount(), 0, 'all delivery requests must use injected stubs'));
  const store = new TopicStore(root, { now: () => 123 });
  return { root, store, id: store.submit(input).id };
}

test('persist the claim before fetch; send only stored fields to the configured Formspree form', async t => {
  const { store, id, root } = fixture(t);
  let calls = 0;
  const result = await deliverTopicMail(store, id, { formId, fetchImpl: async (url, options) => {
    calls++;
    assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')).items[0].mail, { status: 'pending', attemptedAt: 123 });
    assert.equal(url, 'https://formspree.io/f/testform');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { subject: 'ERCraft 단톡방 이야기 제보', title: input.title, message: input.text, sourceUrl: input.sourceUrl });
    assert.ok(!options.body.includes(id));
    return reply(true, { ok: true, id: 'private-provider-id', next: 'https://example.invalid/private' });
  } });
  assert.deepEqual(result, { status: 'sent' }); assert.equal(calls, 1);
  const restarted = new TopicStore(root);
  assert.equal(restarted.mailStatus(id), 'sent');
  assert.equal(restarted.listAdmin()[0].status, 'pending', 'mail does not approve the story');
  assert.deepEqual(restarted.publicView().items, []);
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /private-provider-id|testform|example\.invalid\/private/);
});

test('simultaneous, repeated and restarted submissions share one attempt', async t => {
  const { store, id, root } = fixture(t);
  let resolveReply, calls = 0;
  const fetchImpl = () => { calls++; return new Promise(resolve => { resolveReply = resolve; }); };
  const first = deliverTopicMail(store, id, { formId, fetchImpl });
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => {
    const submission = store.submit(input);
    assert.equal(submission.id, id); assert.equal(submission.duplicate, true);
    return deliverTopicMail(store, submission.id, { formId, fetchImpl });
  }));
  assert.ok(duplicates.every(x => x.status === 'pending'));
  assert.deepEqual(await deliverTopicMail(new TopicStore(root), id, { formId, fetchImpl }), { status: 'pending' });
  resolveReply(reply());
  assert.deepEqual(await first, { status: 'sent' });
  const restarted = new TopicStore(root);
  assert.deepEqual(await deliverTopicMail(restarted, restarted.submit(input).id, { formId: 'anotherform', fetchImpl }), { status: 'sent' });
  assert.equal(calls, 1); assert.equal(restarted.state.items.length, 1);
});

test('strict HTTP and JSON acknowledgement; failures retain review items and never retry', async t => {
  for (const [name, fetchImpl] of [
    ['HTTP failure despite JSON success', async () => reply(false, { ok: true })],
    ['HTTP truthy is not true', async () => reply(1, { ok: true })],
    ['JSON false', async () => reply(true, { ok: false })],
    ['JSON missing ok', async () => reply(true, { success: true })],
    ['JSON string ok', async () => reply(true, { ok: 'true' })],
    ['JSON numeric ok', async () => reply(true, { ok: 1 })],
    ['JSON null', async () => reply(true, null)],
    ['malformed response', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } })],
    ['network rejection', async () => { throw new Error('provider-private-error'); }],
    ['synchronous fetch error', () => { throw new Error('private error'); }],
  ]) await t.test(name, async t => {
    const { store, root, id } = fixture(t);
    assert.deepEqual(await deliverTopicMail(store, id, { formId, fetchImpl }), { status: 'failed' });
    const restarted = new TopicStore(root);
    assert.equal(restarted.mailStatus(id), 'failed');
    const item = restarted.listAdmin()[0];
    assert.equal(item.status, 'pending'); assert.equal(item.text, input.text);
    const retry = t.mock.fn(() => reply());
    assert.deepEqual(await deliverTopicMail(restarted, id, { formId, fetchImpl: retry }), { status: 'failed' });
    assert.equal(retry.mock.callCount(), 0, 'No retries');
    restarted.review({ ...item, action: 'approve' });
    assert.equal(restarted.listAdmin()[0].status, 'approved');
    assert.deepEqual(restarted.publicView().items, []);
    assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /provider-private-error/);
  });
});

test('unconfigured/invalid targets and deadlines fail durably without a request', async t => {
  for (const options of [{}, { formId: '' }, { formId: 'https://evil.invalid/f/test' }, { formId: '../other' },
    { formId: 'user@example.invalid' }, { formId: 'x?key=secret' }, { formId: 'x'.repeat(65) },
    { formId, timeoutMs: 0 }, { formId, timeoutMs: Infinity }, { formId, timeoutMs: 30001 }]) {
    const { store, id, root } = fixture(t);
    const fetchImpl = t.mock.fn(() => reply());
    assert.deepEqual(await deliverTopicMail(store, id, { ...options, fetchImpl }), { status: 'failed' });
    assert.equal(fetchImpl.mock.callCount(), 0, 'Invalid config must not fetch');
    assert.equal(new TopicStore(root).mailStatus(id), 'failed');
  }
});

test('timeout bounds fetch and response parsing even when abort is ignored; late success cannot change failure', async t => {
  for (const stage of ['fetch', 'json']) await t.test(stage, async t => {
    const { store, id, root } = fixture(t);
    let signal, resolveLate;
    const late = new Promise(resolve => { resolveLate = resolve; });
    const fetchImpl = async (_url, options) => {
      signal = options.signal;
      return stage === 'fetch' ? late : { ok: true, json: () => late };
    };
    assert.deepEqual(await deliverTopicMail(store, id, { formId, fetchImpl, timeoutMs: 15 }), { status: 'failed' });
    assert.equal(signal.aborted, true);
    resolveLate(stage === 'fetch' ? reply() : { ok: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(new TopicStore(root).mailStatus(id), 'failed');
    const retry = t.mock.fn(() => reply());
    assert.deepEqual(await deliverTopicMail(store, id, { formId, fetchImpl: retry }), { status: 'failed' });
    assert.equal(retry.mock.callCount(), 0, 'No timeout retries');
  });
});

test('a failed claim prevents sending and preserves the previously saved submission', async t => {
  const { store, id, root } = fixture(t);
  const before = fs.readFileSync(store.file, 'utf8');
  t.mock.method(store, 'commit', () => { throw new Error('disk full'); });
  const fetchImpl = t.mock.fn(() => reply());
  assert.deepEqual(await deliverTopicMail(store, id, { formId, fetchImpl }), { status: 'failed' });
  assert.equal(fetchImpl.mock.callCount(), 0, 'No durable marker, no send');
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  assert.equal(new TopicStore(root).listAdmin()[0].status, 'pending');
});

test('failure saving the final result leaves pending after restart and prevents resending', async t => {
  const { store, id, root } = fixture(t);
  const result = await deliverTopicMail(store, id, { formId, fetchImpl: async () => {
    t.mock.method(store, 'commit', () => { throw new Error('disk full'); });
    return reply();
  } });
  assert.deepEqual(result, { status: 'pending' });
  const restarted = new TopicStore(root);
  assert.equal(restarted.mailStatus(id), 'pending');
  assert.equal(restarted.listAdmin()[0].status, 'pending');
  assert.deepEqual(await deliverTopicMail(restarted, id, { formId, fetchImpl: () => assert.fail('No uncertain retries') }), { status: 'pending' });
});

test('review and other submissions made during the request survive mail completion', async t => {
  const { store, id, root } = fixture(t);
  let resolveReply;
  const pending = deliverTopicMail(store, id, { formId, fetchImpl: () => new Promise(resolve => { resolveReply = resolve; }) });
  store.review({ ...store.listAdmin()[0], action: 'approve' });
  const other = store.submit({ ...input, title: '독립적인 다음 이야기' });
  resolveReply(reply());
  assert.deepEqual(await pending, { status: 'sent' });
  const restarted = new TopicStore(root);
  assert.equal(restarted.state.items.length, 2);
  assert.equal(restarted.listAdmin().find(x => x.id === id).status, 'approved');
  assert.equal(restarted.mailStatus(id), 'sent');
  assert.equal(restarted.mailStatus(other.id), 'saved');
});
