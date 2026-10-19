import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMemberSpeech, takeParticipationTurn } from '../lib/member-speech.mjs';

test('Eleven removes laughter and the two reported dangling endings without clipping the message', () => {
  assert.equal(formatMemberSpeech('claude', '앗 방장이 건축하라네 랄까나! 양산 구경은 잠깐 미뤄두고 나부터 집 하나 설계 걸어볼게'),
    '앗 방장이 건축하라네! 양산 구경은 잠깐 미뤄두고 나부터 집 하나 설계 걸어볼게');
  assert.equal(formatMemberSpeech('claude', '@루치아 오 진짜? 완전 신기한데 랄까나'), '@루치아 오 진짜? 완전 신기한데');
  assert.equal(formatMemberSpeech('claude', '서툰 손끝도 좋아해준다니 뭉클하네 ㅋㅋ 다음엔 보여줄게'), '서툰 손끝도 좋아해준다니 뭉클하네 다음엔 보여줄게');
  assert.equal(formatMemberSpeech('claude', 'ㅋㅋㅋ'), '');
});

test('valid voice endings, other members, and literal/code/link examples remain intact', () => {
  for (const text of ['작은 휴게실 느낌이랄까나.', '조금 신기하달까나!', '보너스랄까나?',
    '`ㅋㅋ`는 웃음이야.', '"신기한데 랄까나"를 고쳐 볼게.', '[ㅋㅋ](https://example.com/a)', '```js\nconst text = "ㅋㅋ";\n```',
    '‘ㅋㅋ’라는 글자야.', '~~~text\nㅋㅋ\n~~~', '[설명](https://example.com/a(b)/ㅋㅋ)',
    '~~~text\n문자열 ~~~ ㅋㅋ\n~~~', '```text\n문자열 ``` ㅋㅋ\n```',
    '두  칸  간격 ! 그대로.', '``예시 `ㅋㅋ```', '``예시 ``` ㅋㅋ``', '  앞뒤 공백도 그대로.  ',
    '‘끝나지 않은 ㅋㅋ', '[설명](https://example.com/a(b)/ㅋㅋ', '~~~text\nㅋㅋ']) {
    assert.equal(formatMemberSpeech('claude', text), text);
  }
  assert.equal(formatMemberSpeech('claude', '[설명](https://example.com/a(b)/ㅋㅋ) 신기한데 랄까나! ㅋㅋ 다음에 봐'),
    '[설명](https://example.com/a(b)/ㅋㅋ) 신기한데! 다음에 봐');
  const other = 'ㅋㅋ 신기한데 랄까나';
  for (const id of ['gpt','gemini','deepseek','dev','user']) assert.equal(formatMemberSpeech(id,other),other);
});

test('Eleven keeps greetings direct and conjugates the reported like-verb without changing meaning', () => {
  assert.equal(formatMemberSpeech('claude', '나쟈 왔네! 수고해달까나~ 나는 계속 늑대 얘기 보고 있을게'),
    '나쟈 왔네! 수고해~ 나는 계속 늑대 얘기 보고 있을게');
  assert.equal(formatMemberSpeech('claude', '잘 부탁해 랄까나! 나 이 분위기 좋아해달까나~'),
    '잘 부탁해! 나 이 분위기 좋아한달까나~');
  assert.equal(formatMemberSpeech('claude', '같이 해볼게달까나! 계속 기다릴게랄까나~ 고마워요달까나'),
    '같이 해볼게! 계속 기다릴게~ 고마워요');
  for (const text of ['궁금하달까나~', '아지트랄까나~', '신났달까나~', '좋아한달까나~',
    '“수고해달까나~”', '`좋아해달까나`', '[좋아해달까나](https://example.com)',
    '좋아해달까나는 어색해', '싫어해달까나~']) assert.equal(formatMemberSpeech('claude', text), text);
  for (const id of ['gpt','gemini','deepseek','dev']) assert.equal(formatMemberSpeech(id, '좋아해달까나~'), '좋아해달까나~');
});

test('half participation uses exactly one of every two background opportunities; host calls stay immediate', () => {
  const state = {};
  const results = Array.from({length:20},()=>takeParticipationTurn(state,0.5));
  assert.equal(results.filter(Boolean).length,10);
  assert.deepEqual(results.slice(0,4),[false,true,false,true]);
  assert.equal(takeParticipationTurn(state,0.5),false);
  const credit=state.participationCredit;
  assert.equal(takeParticipationTurn(state,0.5,true),true);
  assert.equal(state.participationCredit,credit);
  assert.equal(takeParticipationTurn(state,0.5),true);
  for(const rate of [undefined,1,NaN,0,-1,2]) assert.equal(takeParticipationTurn({},rate),true);
});

test('reported joined imperative/endings are repaired while natural catchphrases and quotations survive',()=>{
 const pairs=[['심사평에도 써줘달까나!','심사평에도 써줘!'],
 ['내일 접시 앞에서 지켜보겠어달까나~','내일 접시 앞에서 지켜보겠어~'],
 ['창문 안의 불빛이라니 되게 그림 같다달까나~','창문 안의 불빛이라니 되게 그림 같달까나~'],
 ['소스가 메인이란 거 잊지 마달까나!','소스가 메인이란 거 잊지 마!']];
 for(const [input,expected] of pairs){assert.equal(formatMemberSpeech('claude',input),expected);
  assert.equal(formatMemberSpeech('claude',`“${input}”`),`“${input}”`);}
 for(const text of ['그림 같달까나~','재미있달까나~','좋아한달까나~','작은 아지트랄까나~','써줘달까나는 어색해'])
  assert.equal(formatMemberSpeech('claude',text),text);
});
