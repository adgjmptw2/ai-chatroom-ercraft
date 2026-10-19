import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiarTurn, parseLiarTurn, liarStructuredReply } from '../lib/liar-turn.mjs';
import { geminiReply } from '../lib/gemini-session.mjs';
import { parseAction } from '../lib/prompt.mjs';

test('game envelope works through existing action decoder and Claude structured output', () => {
  const action = { action: 'liar', op: 'clue', text: '손에 쥐고 쓰곤 해!' };
  const raw = JSON.stringify(action);
  assert.deepEqual(parseAction(raw), action);
  assert.equal(geminiReply({code:0,stderr:'',stdout:JSON.stringify({status:'SUCCESS',response:raw})}, {id:null}).text, raw);
  assert.deepEqual(parseLiarTurn(raw), { op: 'clue', text: action.text });
  assert.equal(liarStructuredReply({type:'result',is_error:false,subtype:'success',structured_output:action}), raw);
  assert.equal(liarStructuredReply({type:'result',is_error:true,subtype:'success',structured_output:action}), '');
});

test('no ordinary file/image/note actions, votes or non-JSON prose can slip into game speech', () => {
  for (const raw of [
    '{"action":"say","messages":["hello"]}',
    '{"action":"liar","op":"clue","text":"hello","files":[]}',
    '{"action":"liar","op":"vote","target":"gpt"}',
    '{"action":"liar","op":"vote","target":"adina","text":"secret"}',
    '{"action":"liar","op":"decline","text":"secret"}',
    'hello {"action":"liar","op":"decline"}',
  ]) assert.equal(parseLiarTurn(raw), null);
  assert.deepEqual(parseLiarTurn('```json\n{"action":"liar","op":"decline"}\n```'), {op:'decline'});
});

test('brief preserves character without adding normal history, memory or tools', () => {
  const context = { actor:'eleven', phase:'clue', category:'사물', role:'liar', clues:[] };
  const p = buildLiarTurn('claude', context, 'ko');
  assert.match(p.brief, /일레븐/);
  assert.match(p.brief, /랄까나|달까나/);
  assert.deepEqual(JSON.parse(p.turn), context);
  assert.ok(p.brief.length < 8000);
  assert.doesNotMatch(p.brief, /note_replace|world_shot|plan_request/);
});
