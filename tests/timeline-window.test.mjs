import test from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_MESSAGES, HISTORY_PAGE, MAX_ROWS, MAX_PENDING, uniqueMessages, rememberPending, recentSnapshot, overlaps } from '../public/timeline-window.js';
const message = id => ({ id, from: 'eleven', ts: id, text: `synthetic ${id}` });

test('client limits and defensive last80 selection even with a legacy1000 snapshot', () => {
  assert.equal(RECENT_MESSAGES, 80); assert.equal(HISTORY_PAGE, 60); assert.equal(MAX_ROWS, 180);
  const tail = recentSnapshot(Array.from({ length: 1000 }, (_, i) => message(i + 1)));
  assert.deepEqual(tail.map(m => m.id), Array.from({ length: 80 }, (_, i) => i + 921));
});

test('bounded pending SSE retains newest ids and merges partial reactions after snapshot', () => {
  const pending = new Map();
  for (let i = 1001; i <= 2000; i++) rememberPending(pending, message(i));
  rememberPending(pending, message(2000));
  rememberPending(pending, { id: 1999, reactions: { '👍': ['user'] } });
  rememberPending(pending, { id: 12, reactions: { '👍': ['user'] } });
  assert.equal(pending.size, MAX_PENDING);
  const tail = recentSnapshot(Array.from({ length: 80 }, (_, i) => message(i + 921)), pending);
  assert.deepEqual(tail.map(m => m.id), Array.from({ length: 80 }, (_, i) => i + 1921));
  assert.deepEqual(tail.at(-2).reactions, { '👍': ['user'] });
  assert.equal(tail.at(-2).text, 'synthetic 1999');
  assert.equal(overlaps([message(1000)], tail), false);
  assert.equal(overlaps([message(1990)], tail), true);
});

test('duplicates, invalid ids and partial unknown updates do not create phantom rows', () => {
  assert.deepEqual(uniqueMessages([message(2), message(1), { id: 2, reactions: {} }, { id: NaN }, { id: -1 }]), [message(1), { ...message(2), reactions: {} }]);
  const pending = new Map();
  rememberPending(pending, { id: 100, reactions: {} });
  rememberPending(pending, { id: Infinity });
  assert.deepEqual(recentSnapshot([message(1)], pending), [message(1)]);
});
