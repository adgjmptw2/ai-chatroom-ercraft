import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiarGame } from '../lib/liar-game.mjs';

const BASE = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000, LEAD = 10 * MINUTE, CADENCE = 6 * 60 * MINUTE, GAP = 12_000;
const READY = { running: true, available: true, busy: false };
const IDS = ['adina', 'bianca', 'eleven', 'lucia'];
const START = 1_800_000_000_000;

function fixture(t, randomInt = () => 0) {
  const home = mkdtempSync(join(BASE, '.liar-fixture-'));
  t.after(() => {
    // Only remove this test's synthetic directory; never use a runtime or shared home.
    assert.equal(dirname(resolve(home)), resolve(BASE));
    assert.ok(home.startsWith(join(BASE, '.liar-fixture-')));
    rmSync(home, { recursive: true, force: true });
  });
  const f = { home, file: join(home, 'data', 'liar-game.json'), now: START, randomInt };
  f.restart = () => (f.game = new LiarGame(home, { now: () => f.now, randomInt }));
  f.restart();
  f.raw = () => JSON.parse(readFileSync(f.file, 'utf8'));
  f.view = () => f.game.view(f.now);
  f.advance = (time = f.now, flags = READY) => { f.now = time; return f.game.advance(time, flags); };
  f.start = () => { f.advance(f.view().nextStartAt); assert.equal(f.view().round.status, 'active'); };
  f.reserve = () => {
    const ticket = f.game.pending(f.now);
    assert.ok(ticket, 'one actionable turn');
    const claim = f.game.claim(ticket, f.now);
    assert.equal(claim.ok, true);
    return { ticket, token: claim.token, context: f.game.context(ticket.actor, claim.token) };
  };
  f.act = action => {
    const { ticket, token } = f.reserve();
    const result = f.game.submit(token, ticket.actor, action ?? { op: ticket.phase, text: '느낌이 잔잔해요.' }, f.now);
    f.now += GAP;
    return result;
  };
  f.toVotes = () => { for (let i = 0; i < 8; i++) assert.equal(f.act().ok, true); };
  f.accuse = target => {
    for (let i = 0; i < 4; i++) {
      const actor = f.game.pending(f.now).actor;
      assert.equal(f.act({ op: 'vote', target: actor === target ? IDS.find(p => p !== target) : target }).ok, true);
    }
  };
  return f;
}

function seeded(seed) {
  return max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
}

function assertActiveProjection(f) {
  const view = f.view(), raw = f.raw(), round = view.round;
  assert.equal(round.result, null);
  assert.deepEqual(Object.keys(view).sort(), ['version', 'revision', 'serverNow', 'nextStartAt', 'noticeAt', 'round'].sort());
  assert.deepEqual(Object.keys(round).sort(), ['id', 'phase', 'status', 'category', 'players', 'turn', 'step', 'totalSteps',
    'startedAt', 'deadlineAt', 'clues', 'submitted', 'result'].sort());
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /"(?:word|wordId|liar|role|votes|target|claim|token|aliases|recentWordIds|readyAt|scheduledAt|instruction)"/);
  if (raw.round.claim) assert.ok(!serialized.includes(raw.round.claim.token));
  assert.deepEqual([...round.players].sort(), IDS);
}

test('initial schedule is now + ten minutes; notice is once, persisted, and cadence remains six hours', t => {
  const f = fixture(t);
  assert.deepEqual(f.view(), { version: 1, revision: 0, serverNow: START, nextStartAt: START + LEAD, noticeAt: START, round: null });
  assert.equal(f.advance().notices.length, 1);
  assert.deepEqual(f.advance(), { changed: false, notices: [] });
  f.restart();
  assert.deepEqual(f.advance(), { changed: false, notices: [] });
  assert.equal(f.advance(START + LEAD - 1).changed, false);
  f.advance(START + LEAD);
  assert.equal(f.view().round.startedAt, START + LEAD);
  assert.equal(f.view().nextStartAt, START + LEAD + CADENCE);
  assert.equal(f.view().noticeAt, START + CADENCE);
});

test('numeric now injection and seeded random source produce identical private states and tokens', t => {
  const a = fixture(t, seeded(71)), b = fixture(t, seeded(71));
  const numeric = new LiarGame(a.home, { now: START, randomInt: seeded(71) });
  assert.deepEqual(numeric.view(START), a.view());
  a.start(); b.start();
  assert.deepEqual(a.raw(), b.raw());
  assert.deepEqual(a.reserve(), b.reserve());
  assert.deepEqual(a.raw(), b.raw());
});

for (const missing of IDS) test(`missing ${missing} waits within grace and starts after recovery`, t => {
  const f = fixture(t);
  const providerReady = Object.fromEntries(IDS.map(id => [id, id !== missing]));
  const due = f.view().nextStartAt;
  f.advance(due, { ...READY, available: IDS.every(id => providerReady[id]) });
  assert.equal(f.view().round, null);
  assert.equal(f.view().nextStartAt, due);
  assert.equal(f.game.pending(f.now), null);
  f.advance(due + MINUTE);
  assert.equal(f.view().round.status, 'active');
  assert.equal(f.view().nextStartAt, due + CADENCE);
});

test('an unavailable provider still skips at the grace deadline without catch-up', t => {
  const f=fixture(t), due=f.view().nextStartAt;
  f.advance(due,{...READY,available:false});
  f.advance(due+LEAD,{...READY,available:false});
  assert.equal(f.view().round,null);assert.equal(f.view().nextStartAt,due+CADENCE);
  f.advance(due+LEAD+1);assert.equal(f.view().round,null);
});

test('maintenance repair is compare-and-set and only moves an unplayed future calendar with ten-minute notice', t => {
  const f=fixture(t), due=f.view().nextStartAt;
  f.advance(due+LEAD,{...READY,busy:true});
  const expected={revision:f.view().revision,nextStartAt:f.view().nextStartAt};
  const before=readFileSync(f.file,'utf8');
  assert.deepEqual(f.game.rescheduleUnplayed(f.now,{...expected,revision:expected.revision-1}),{ok:false});
  assert.equal(readFileSync(f.file,'utf8'),before);
  assert.equal(f.game.rescheduleUnplayed(f.now,expected).ok,true);
  assert.equal(f.view().nextStartAt,f.now+LEAD);
  assert.deepEqual(f.game.rescheduleUnplayed(f.now,expected),{ok:false});
  f.restart();assert.equal(f.view().nextStartAt,f.now+LEAD);
  f.start();
  assert.deepEqual(f.game.rescheduleUnplayed(f.now,{revision:f.view().revision,nextStartAt:f.view().nextStartAt}),{ok:false});
});

test('offline missed slots skip arithmetically without a burst, calls, or off-room notices', t => {
  const f = fixture(t), due = f.view().nextStartAt;
  const result = f.advance(due + 80 * CADENCE + MINUTE, { ...READY, running: false });
  assert.deepEqual(result, { changed: true, notices: [] });
  assert.equal(f.view().nextStartAt, due + 81 * CADENCE);
  assert.equal(f.game.pending(f.now), null);
  f.advance(f.now + 1);
  assert.equal(f.view().round, null);
  f.restart();
  assert.equal(f.view().nextStartAt, due + 81 * CADENCE);
});

test('a restart within ten minutes after an unstarted slot conservatively skips that offline slot', t => {
  const f = fixture(t), due = f.view().nextStartAt;
  f.now = due + MINUTE;
  f.restart(); f.advance();
  assert.equal(f.view().round, null);
  assert.equal(f.view().nextStartAt, due + CADENCE);
});

test('busy may delay start just under ten minutes; next slot stays anchored to the scheduled start', t => {
  const f = fixture(t), due = f.view().nextStartAt;
  f.advance(due, { ...READY, busy: true });
  assert.equal(f.view().round, null);
  assert.equal(f.game.pending(f.now), null);
  f.advance(due + LEAD - 1);
  assert.equal(f.view().round.startedAt, due + LEAD - 1);
  assert.equal(f.view().nextStartAt, due + CADENCE);
});

test('at ten-minute busy grace boundary the slot is neutrally skipped, with no fabricated game outcome', t => {
  const f = fixture(t), due = f.view().nextStartAt;
  f.advance(due, { ...READY, busy: true });
  assert.equal(f.advance(due + LEAD - 1, { ...READY, busy: true }).changed, false);
  const skipped = f.advance(due + LEAD);
  assert.equal(skipped.changed, true);
  assert.equal(skipped.notices.length, 1);
  assert.doesNotMatch(JSON.stringify(skipped), /우산|liar|citizens/);
  assert.equal(f.view().round, null);
  assert.equal(f.view().nextStartAt, due + CADENCE);
  assert.equal(f.advance(due + LEAD + 1).changed, false);
});

test('long stalls skip expired starts, preserve cadence, and do not issue multiple notices', t => {
  const f = fixture(t), due = f.view().nextStartAt;
  assert.equal(f.advance(due + 9 * CADENCE + LEAD).notices.length, 1);
  assert.equal(f.view().round, null);
  assert.equal(f.view().nextStartAt, due + 10 * CADENCE);
});

test('tickets bind round, revision, actor, phase; claims persist before dispatch and duplicates do nothing', t => {
  const f = fixture(t); f.start();
  const ticket = f.game.pending(f.now), before = readFileSync(f.file, 'utf8');
  for (const bad of [null, {}, { ...ticket, actor: 'not-public' }, { ...ticket, revision: ticket.revision + 1 },
    { ...ticket, roundId: 'stale' }, { ...ticket, phase: 'guess' }, { ...ticket, extra: true }]) {
    assert.deepEqual(f.game.claim(bad, f.now), { ok: false });
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
  const { token } = f.game.claim(ticket, f.now);
  assert.equal(f.raw().round.claim.token, token);
  assert.equal(f.raw().round.claim.expiresAt, f.now + 3 * MINUTE);
  assert.deepEqual(f.game.claim(ticket, f.now), { ok: false });
  assert.equal(f.game.pending(f.now), null);
  assert.equal(f.game.context('not-public', token), null);
  assert.equal(f.game.context(ticket.actor, 'stale'), null);
  assert.equal(f.game.context(ticket.actor, undefined), null);
  f.restart();
  assert.equal(f.game.pending(f.now), null, 'restart does not dispatch again');
  assert.deepEqual(f.game.claim(ticket, f.now), { ok: false });
  assert.ok(f.game.context(ticket.actor, token), 'an already running completion still has its original reservation');
});

test('recovered in-flight claim waits exactly to timeout, cancels, and rejects late completion with zero retries', t => {
  const f = fixture(t); f.start();
  const { ticket, token } = f.reserve(), claimedAt = f.now;
  f.restart();
  assert.deepEqual(f.advance(claimedAt + 3 * MINUTE - 1), { changed: false, notices: [] });
  assert.equal(f.game.pending(f.now), null);
  const expired = f.advance(claimedAt + 3 * MINUTE);
  assert.equal(expired.changed, true);
  assert.equal(f.view().round.result.outcome, 'cancelled');
  const finished = readFileSync(f.file, 'utf8');
  assert.deepEqual(f.game.submit(token, ticket.actor, { op: 'clue', text: '느낌이 잔잔해요.' }, f.now), { ok: false, changed: false, notices: [] });
  assert.deepEqual(f.game.fail(token, ticket.actor, f.now), { ok: false, changed: false, notices: [] });
  assert.equal(readFileSync(f.file, 'utf8'), finished);
  assert.equal(f.game.context(ticket.actor, token), null);
});

test('restart with a completed action never repeats that action; exactly twelve seconds separates turns', t => {
  const f = fixture(t); f.start();
  const { ticket, token } = f.reserve(), now = f.now;
  assert.equal(f.game.submit(token, ticket.actor, { op: 'clue', text: '느낌이 잔잔해요.' }, now).ok, true);
  f.restart();
  assert.equal(f.game.pending(now + GAP - 1), null);
  assert.ok(f.game.pending(now + GAP));
  assert.deepEqual(f.game.submit(token, ticket.actor, { op: 'clue', text: '다시 적어요.' }, now + GAP), { ok: false, changed: false, notices: [] });
  assert.deepEqual(f.game.claim(ticket, now + GAP), { ok: false });
  assert.equal(f.view().round.clues.length, 1);
  assert.equal(f.game.context(ticket.actor, undefined), null);
});

test('private actor context exposes only the citizen word and own role, never anyone else or private votes', t => {
  const f = fixture(t); f.start();
  const liar = f.raw().round.liar;
  for (let step = 0; step < 12; step++) {
    const { ticket, token, context } = f.reserve();
    assert.equal(context.actor, ticket.actor);
    assert.equal(context.role, ticket.actor === liar ? 'liar' : 'citizen');
    assert.equal(Object.hasOwn(context, 'word'), ticket.actor !== liar);
    if (ticket.actor !== liar) assert.equal(context.word, '우산');
    assert.doesNotMatch(JSON.stringify(context), /"(?:liar|votes|target|token|claim|aliases|wordId)"\s*:/);
    assert.match(context.instruction, /decline/);
    assert.match(context.instruction, /만들기·먹기·이동하기/);
    assertActiveProjection(f);
    const action = ticket.phase === 'vote' ? { op: 'vote', target: ticket.actor === liar ? IDS.find(p => p !== liar) : liar } :
      { op: ticket.phase, text: '느낌이 잔잔해요.' };
    assert.equal(f.game.submit(token, ticket.actor, action, f.now).ok, true);
    f.now += GAP;
  }
  const { ticket, token, context } = f.reserve();
  assert.equal(ticket.phase, 'guess'); assert.equal(ticket.actor, liar);
  assert.equal(context.role, 'liar'); assert.equal(Object.hasOwn(context, 'word'), false);
  assert.equal(f.game.context(IDS.find(p => p !== liar), token), null);
  assertActiveProjection(f);
});

test('public view/context are detached projections whose mutation cannot change the engine', t => {
  const f = fixture(t); f.start(); f.act();
  const { context } = f.reserve();
  const before = f.raw(), view = f.view();
  view.round.players[0] = 'outsider'; view.round.clues[0].text = '우산';
  view.round.submitted.push('outsider'); context.players.length = 0;
  context.clues[0].text = '우산'; context.choices.push('outsider');
  assert.deepEqual(f.raw(), before);
  assertActiveProjection(f);
  assert.equal(f.view().round.clues[0].text, '느낌이 잔잔해요.');
});

for (const guess of ['우 산!!', 'ＵＭＢＲＥＬＬＡ', 'u-m_b r.e!l l a', '우-산']) {
  test(`caught liar has exactly one normalized guess: ${guess}`, t => {
    const f = fixture(t); f.start();
    const due = f.raw().round.scheduledAt, liar = f.raw().round.liar;
    f.toVotes(); f.accuse(liar);
    assert.equal(f.view().round.phase, 'guess');
    assert.equal(f.view().round.step, 12);
    const { ticket, token } = f.reserve();
    const result = f.game.submit(token, ticket.actor, { op: 'guess', text: guess }, f.now);
    assert.equal(result.ok, true); assert.equal(result.finished, true); assert.equal(result.speech, undefined);
    assert.equal(f.view().round.step, 13); assert.equal(f.game.pending(f.now + GAP), null);
    assert.deepEqual(f.view().round.result, { outcome: 'liar', liar, word: '우산', votes: f.raw().round.votes, guess });
    assert.equal(f.view().nextStartAt, due + CADENCE);
    assert.deepEqual(f.game.submit(token, ticket.actor, { op: 'guess', text: '다른 답' }, f.now), { ok: false, changed: false, notices: [] });
    f.restart();
    assert.equal(f.view().round.result.outcome, 'liar');
  });
}

test('caught liar with an incorrect single guess yields citizens; a containing sentence is not an exact alias', t => {
  const f = fixture(t); f.start(); f.toVotes(); f.accuse(f.raw().round.liar);
  assert.equal(f.act({ op: 'guess', text: '정답은 우산입니다' }).finished, true);
  assert.equal(f.view().round.result.outcome, 'citizens');
  assert.equal(f.view().round.result.guess, '정답은 우산입니다');
});

test('incorrect unique accusation yields liar victory after twelve actions, without an extra guess', t => {
  const f = fixture(t); f.start(); f.toVotes();
  const citizen = IDS.find(p => p !== f.raw().round.liar);
  f.accuse(citizen);
  const view = f.view();
  assert.equal(view.round.result.outcome, 'liar'); assert.equal(view.round.step, 12);
  assert.equal(Object.hasOwn(view.round.result, 'guess'), false);
  assert.equal(f.game.pending(f.now), null);
});

for (const twoWay of [false, true]) test(`${twoWay ? 'two-way' : 'four-way'} tied vote is a draw without choosing a winner`, t => {
  const f = fixture(t); f.start(); f.toVotes();
  const [a, b, c, d] = f.view().round.players;
  const targets = twoWay ? [b, a, a, b] : [b, c, d, a];
  for (const target of targets) assert.equal(f.act({ op: 'vote', target }).ok, true);
  assert.equal(f.view().round.result.outcome, 'draw');
  assert.equal(f.view().round.step, 12); assert.equal(f.game.pending(f.now), null);
  f.restart(); assert.equal(f.view().round.result.outcome, 'draw');
});

test('a 2-1-1 plurality can catch the liar without requiring an absolute majority', t => {
  const f = fixture(t); f.start(); f.toVotes();
  const [liar, b, c, d] = f.view().round.players;
  assert.equal(liar, f.raw().round.liar);
  for (const target of [b, liar, liar, c]) f.act({ op: 'vote', target });
  assert.equal(f.view().round.phase, 'guess'); assert.equal(f.view().round.turn, null);
  assert.equal(f.view().round.result, null);
});

test('each player has one clue, one discussion, and one private vote; submitted reveals no targets', t => {
  const f = fixture(t); f.start();
  const order = f.view().round.players;
  for (let i = 0; i < 8; i++) {
    assert.equal(f.game.pending(f.now).actor, order[i % 4]);
    const result = f.act();
    assert.deepEqual(result.speech, { actor: order[i % 4], text: '느낌이 잔잔해요.' });
  }
  for (let i = 0; i < 3; i++) {
    const actor = f.game.pending(f.now).actor;
    const result = f.act({ op: 'vote', target: IDS.find(p => p !== actor) });
    assert.equal(result.speech, undefined);
    assert.deepEqual(f.view().round.submitted, order.slice(0, i + 1));
    assertActiveProjection(f);
  }
  assert.equal(new Set(f.raw().round.votes.map(v => v.actor)).size, 3);
  assert.equal(f.view().round.clues.filter(c => c.phase === 'clue').length, 4);
  assert.equal(f.view().round.clues.filter(c => c.phase === 'discussion').length, 4);
});

for (const text of ['우산', '우 - 산', '우\u200b산', 'ＵＭＢＲＥＬＬＡ', 'u.m b_r-e l l a', '우-산', '힌트는 우산이에요']) {
  test(`literal or normalized secret in a clue cancels without leaking: ${text}`, t => {
    const f = fixture(t); f.start();
    const { ticket, token } = f.reserve();
    const result = f.game.submit(token, ticket.actor, { op: 'clue', text }, f.now);
    assert.equal(result.ok, false); assert.equal(result.finished, true); assert.equal(result.speech, undefined);
    assert.equal(f.view().round.result.outcome, 'cancelled');
    assert.equal(f.view().round.result.liar, null); assert.equal(f.view().round.result.word, null);
    assert.deepEqual(f.view().round.result.votes, []); assert.equal(f.view().round.clues.length, 0);
    assert.ok(!JSON.stringify(result).includes(text));
    assert.ok(!JSON.stringify(f.view()).includes(text));
    assert.ok(!readFileSync(f.file, 'utf8').includes(text), 'rejected text never persisted');
  });
}

test('literal secret in discussion is filtered too, including a citizen response', t => {
  const f = fixture(t); f.start();
  for (let i = 0; i < 5; i++) f.act();
  assert.notEqual(f.game.pending(f.now).actor, f.raw().round.liar);
  const result = f.act({ op: 'discussion', text: '우산' });
  assert.equal(result.ok, false); assert.equal(result.speech, undefined);
  assert.equal(f.view().round.clues.length, 5);
  assert.equal(f.view().round.result.word, null);
});

for (const action of [null, {}, { op: 'pass' }, { op: 'clue' }, { op: 'clue', text: 42 },
  { op: 'clue', text: '' }, { op: 'clue', text: '  ' }, { op: 'clue', text: '!!!' },
  { op: 'clue', text: 'pass' }, { op: 'clue', text: '패스' }, { op: 'clue', text: 'x'.repeat(241) },
  { op: 'clue', text: '\u0000private' }, { op: 'clue', text: '힌트', private: 'secret' },
  { op: 'vote', target: 'adina' }]) {
  test(`invalid action cancels once without a repair call: ${JSON.stringify(action)}`, t => {
    const f = fixture(t); f.start();
    const { ticket, token } = f.reserve();
    const result = f.game.submit(token, ticket.actor, action, f.now);
    assert.equal(result.ok, false); assert.equal(result.changed, true);
    assert.equal(result.speech, undefined); assert.equal(f.view().round.result.outcome, 'cancelled');
    assert.equal(f.game.pending(f.now + GAP), null);
    assert.deepEqual(f.game.fail(token, ticket.actor, f.now), { ok: false, changed: false, notices: [] });
  });
}

test('240 Unicode code points are accepted; not truncated or converted into extra actions', t => {
  const f = fixture(t); f.start();
  const text = '느'.repeat(239) + '🫧';
  const result = f.act({ op: 'clue', text });
  assert.equal(result.ok, true); assert.equal(result.speech.text, text);
  assert.equal(f.view().round.step, 1);
});

for (const self of [true, false]) test(`${self ? 'self' : 'non-public actor'} vote cancels without revealing past votes`, t => {
  const f = fixture(t); f.start(); f.toVotes();
  const { ticket, token } = f.reserve();
  const result = f.game.submit(token, ticket.actor, { op: 'vote', target: self ? ticket.actor : 'gpt' }, f.now);
  assert.equal(result.ok, false); assert.equal(f.view().round.result.outcome, 'cancelled');
  assert.deepEqual(f.view().round.result.votes, []); assert.equal(f.view().round.result.word, null);
});

for (const phase of ['clue', 'discussion', 'vote', 'guess']) test(`declining ${phase} freely cancels without assigning winners or revealing roles`, t => {
  const f = fixture(t); f.start();
  if (phase !== 'clue') for (let i = 0; i < 4; i++) f.act();
  if (phase === 'vote' || phase === 'guess') for (let i = 0; i < 4; i++) f.act();
  if (phase === 'guess') f.accuse(f.raw().round.liar);
  const due = f.view().nextStartAt;
  assert.equal(f.game.pending(f.now).phase, phase);
  const result = f.act({ op: 'decline' });
  assert.equal(result.ok, true); assert.equal(result.finished, true); assert.equal(result.speech, undefined);
  assert.deepEqual(f.view().round.result, { outcome: 'cancelled', liar: null, word: null, votes: [], reason: result.notices[0] });
  assert.equal(f.view().nextStartAt, due); assert.equal(f.game.pending(f.now), null);
  f.restart(); assert.equal(f.view().round.result.outcome, 'cancelled');
});

test('provider failure has a neutral reason and stale/wrong-actor tokens cannot cancel someone else', t => {
  const f = fixture(t); f.start();
  const { ticket, token } = f.reserve();
  const before = readFileSync(f.file, 'utf8');
  assert.equal(f.game.fail(token, IDS.find(p => p !== ticket.actor), f.now).changed, false);
  assert.equal(f.game.fail('stale', ticket.actor, f.now).changed, false);
  assert.equal(f.game.submit('stale', ticket.actor, null, f.now).changed, false);
  assert.equal(f.game.submit(token, 'outsider', null, f.now).changed, false);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const result = f.game.fail(token, ticket.actor, f.now);
  assert.equal(result.changed, true); assert.equal(result.finished, true);
  assert.doesNotMatch(JSON.stringify(result), /token|provider|model|API|우산|bianca/);
  assert.equal(f.view().round.result.word, null);
});

for (const flags of [{ ...READY, running: false }, { ...READY, available: false }]) {
  test(`active round cancels when ${flags.running ? 'a provider becomes unavailable' : 'room stops'} and ignores its late response`, t => {
    const f = fixture(t); f.start();
    const { ticket, token } = f.reserve();
    f.advance(f.now + 1, flags);
    assert.equal(f.view().round.result.outcome, 'cancelled');
    assert.equal(f.game.submit(token, ticket.actor, { op: 'clue', text: '느낌이 잔잔해요.' }, f.now).changed, false);
  });
}

test('busy during an active provider claim does not cancel its own game turn', t => {
  const f = fixture(t); f.start(); f.reserve();
  assert.deepEqual(f.advance(f.now + 1, { ...READY, busy: true }), { changed: false, notices: [] });
  assert.equal(f.view().round.status, 'active');
});

test('overall twenty-minute limit holds without a claim; a near-deadline claim expires at the same bound', t => {
  const f = fixture(t); f.start();
  const end = f.view().round.deadlineAt;
  assert.equal(end, f.now + 20 * MINUTE);
  f.advance(end - 1);
  const { ticket, token } = f.reserve();
  assert.equal(f.raw().round.claim.expiresAt, end);
  const result = f.game.submit(token, ticket.actor, { op: 'clue', text: '느낌이 잔잔해요.' }, end);
  assert.equal(result.ok, false); assert.equal(result.speech, undefined);
  assert.equal(f.view().round.result.outcome, 'cancelled');
  const g = fixture(t); g.start(); g.advance(g.view().round.deadlineAt);
  assert.equal(g.view().round.result.outcome, 'cancelled');
});

test('submission at claim timeout cancels even without an intervening advance call', t => {
  const f = fixture(t); f.start(); const { ticket, token } = f.reserve();
  const result = f.game.submit(token, ticket.actor, { op: 'clue', text: '느낌이 잔잔해요.' }, f.now + 3 * MINUTE);
  assert.equal(result.ok, false); assert.equal(result.changed, true); assert.equal(result.speech, undefined);
  assert.equal(f.game.pending(f.now + 3 * MINUTE), null);
});

test('backward submission clocks and invalid timestamps never consume the reservation', t => {
  const f = fixture(t); f.start(); const { ticket, token } = f.reserve();
  const before = readFileSync(f.file, 'utf8');
  assert.equal(f.game.submit(token, ticket.actor, { op: 'decline' }, f.now - 1).changed, false);
  assert.equal(f.game.fail(token, ticket.actor, f.now - 1).changed, false);
  for (const time of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => f.game.advance(time, READY), /Invalid game time/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('finished round survives until the next actual round, and old tokens cannot affect the replacement', t => {
  const f = fixture(t); f.start();
  const { ticket, token } = f.reserve();
  f.game.submit(token, ticket.actor, { op: 'decline' }, f.now);
  const finished = f.view().round, due = f.view().nextStartAt;
  f.advance(due - LEAD); assert.deepEqual(f.view().round, finished);
  f.restart(); assert.deepEqual(f.view().round, finished);
  f.advance(due); assert.notEqual(f.view().round.id, finished.id);
  const fresh = f.reserve(), before = readFileSync(f.file, 'utf8');
  assert.equal(f.game.fail(token, ticket.actor, f.now).changed, false);
  assert.equal(f.game.submit(token, ticket.actor, { op: 'decline' }, f.now).changed, false);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.notEqual(fresh.token, token);
});

test('at least forty neutral words exist; recent repetition is avoided and storage stays bounded', t => {
  // Choose the smallest unseen word ID; other entropy stays deterministic.
  const seen = new Set(); let f;
  const choose = max => {
    if (max > 4 && max < 100) {
      const recent = f ? f.raw().recentWordIds : [];
      const all = Array.from({ length: max + recent.length }, (_, id) => id).filter(id => !recent.includes(id));
      const index = all.findIndex(id => !seen.has(id));
      return index < 0 ? 0 : index;
    }
    return 0;
  };
  f = fixture(t, choose);
  for (let i = 0; i < 56; i++) {
    const recent = f.raw().recentWordIds;
    f.start();
    const raw = f.raw();
    assert.ok(!recent.includes(raw.round.wordId));
    seen.add(raw.round.wordId);
    assert.equal(f.act({ op: 'decline' }).ok, true);
    assert.ok(f.raw().recentWordIds.length <= 8);
    assert.ok(lstatSync(f.file).size < 10_000);
    f.restart();
  }
  assert.ok(seen.size >= 40, `saw ${seen.size} distinct entries`);
  assert.deepEqual(readdirSync(join(f.home, 'data')), ['liar-game.json']);
});

test('seeded shuffling varies both player order and liar identity over rounds', t => {
  const f = fixture(t, seeded(83)), liars = new Set(), orders = new Set();
  for (let i = 0; i < 32; i++) {
    f.start(); const r = f.raw().round;
    liars.add(r.liar); orders.add(r.players.join(','));
    f.act({ op: 'decline' });
  }
  assert.equal(liars.size, 4); assert.ok(orders.size > 4);
});

test('default secure randomness needs no provider, external dependency, network, or public files', t => {
  const f = fixture(t);
  f.game = new LiarGame(f.home, { now: () => f.now }); f.start();
  assertActiveProjection(f);
  assert.deepEqual(readdirSync(f.home), ['data']);
  assert.deepEqual(readdirSync(join(f.home, 'data')), ['liar-game.json']);
  if (process.platform !== 'win32') assert.equal(lstatSync(f.file).mode & 0o777, 0o600);
});

test('invalid JSON is rejected without changing the original bytes or creating replacement files', t => {
  const f = fixture(t), bytes = Buffer.from('{"private":"must preserve",broken');
  writeFileSync(f.file, bytes);
  assert.throws(() => f.restart(), /private state unavailable/);
  assert.deepEqual(readFileSync(f.file), bytes);
  assert.deepEqual(readdirSync(join(f.home, 'data')), ['liar-game.json']);
});

const corruptions = [
  ['unsupported version', s => { s.version = 2; }],
  ['unknown private property', s => { s.extra = 'secret'; }],
  ['fractional revision', s => { s.revision = 1.2; }],
  ['bad next slot', s => { s.nextStartAt++; }],
  ['duplicate player', s => { s.round.players[0] = s.round.players[1]; }],
  ['unknown liar', s => { s.round.liar = 'provider'; }],
  ['unknown word', s => { s.round.wordId = 10000; }],
  ['bad step', s => { s.round.step = 4; }],
  ['wrong claim actor', s => { s.round.claim.actor = IDS.find(p => p !== s.round.claim.actor); }],
  ['wrong claim phase', s => { s.round.claim.phase = 'vote'; }],
  ['stale claim revision', s => { s.round.claim.revision--; }],
  ['unbounded claim timeout', s => { s.round.claim.expiresAt += MINUTE; }],
  ['claim before spacing', s => { s.round.claim.claimedAt--; }],
  ['malformed token', s => { s.round.claim.token = 'secret'; }],
  ['fabricated finished result', s => { s.round.status = 'finished'; s.round.phase = 'finished'; s.round.claim = null; s.round.result = { outcome: 'citizens' }; }],
  ['active result', s => { s.round.result = { outcome: 'liar' }; }],
];
for (const [label, corrupt] of corruptions) test(`restart fails closed on ${label}, preserving every original byte`, t => {
  const f = fixture(t); f.start(); f.reserve();
  const raw = f.raw(); corrupt(raw);
  const bytes = JSON.stringify(raw); writeFileSync(f.file, bytes);
  assert.throws(() => f.restart(), /private state unavailable/);
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
});

test('a secret-bearing or out-of-order persisted transcript is rejected at restart', t => {
  const f = fixture(t); f.start(); f.act();
  const raw = f.raw();
  for (const clue of [{ ...raw.round.clues[0], text: '우 - 산' }, { ...raw.round.clues[0], actor: 'adina' }]) {
    const bad = structuredClone(raw); bad.round.clues[0] = clue;
    const bytes = JSON.stringify(bad); writeFileSync(f.file, bytes);
    assert.throws(() => f.restart(), /private state unavailable/);
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
  }
});

test('oversized private state is rejected without parsing, truncating, or replacing it', t => {
  const f = fixture(t), bytes = 'x'.repeat(64 * 1024 + 1);
  writeFileSync(f.file, bytes);
  assert.throws(() => f.restart(), /private state unavailable/);
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
});

test('sequential stale engine instances cannot overwrite a persisted claim or double-dispatch', t => {
  const f = fixture(t); f.start();
  const old = new LiarGame(f.home, { now: () => f.now, randomInt: () => 0 });
  const ticket = old.pending(f.now); f.reserve();
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => old.claim(ticket, f.now), /persistence failure/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.throws(() => old.pending(f.now), /disabled/);
});

test('write failure grants no reservation, preserves original file, and poisons the entire engine instance', t => {
  const f = fixture(t); f.start();
  const before = readFileSync(f.file, 'utf8'), ticket = f.game.pending(f.now);
  const moved = join(f.home, 'saved-private-data');
  renameSync(join(f.home, 'data'), moved);
  writeFileSync(join(f.home, 'data'), 'synthetic path obstruction');
  assert.throws(() => f.game.claim(ticket, f.now), /persistence failure/);
  assert.equal(readFileSync(join(moved, 'liar-game.json'), 'utf8'), before);
  for (const call of [() => f.game.view(f.now), () => f.game.pending(f.now), () => f.game.context(ticket.actor, 'anything'),
    () => f.game.advance(f.now, READY), () => f.game.submit('token', ticket.actor, null, f.now),
    () => f.game.fail('token', ticket.actor, f.now)]) assert.throws(call, /disabled/);
  assert.deepEqual(readdirSync(moved), ['liar-game.json']);
});

test('invalid random output fails before committing any start or emitting public speech', t => {
  const f = fixture(t, () => -1), bytes = readFileSync(f.file, 'utf8');
  assert.throws(() => f.advance(f.view().nextStartAt), /random source/);
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
  assert.equal(f.view().round, null);
});
