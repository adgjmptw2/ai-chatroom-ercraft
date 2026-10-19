import test from 'node:test';
import assert from 'node:assert/strict';
import { ER_LORE, ER_LORE_BASE, eternalReturnContext } from '../lib/eternal-return-lore.mjs';
import { buildBrief, buildTurn } from '../lib/prompt.mjs';
import { setLang } from '../lib/i18n.mjs';

const say = text => ({ from: 'user', text });

test('curated lore retains dated primary/official-linked provenance for every card', () => {
  assert.equal(new Set(ER_LORE.cards.map(c => c.id)).size, ER_LORE.cards.length);
  for (const card of ER_LORE.cards) {
    assert.ok(card.text.length < 350);
    for (const key of card.sources) {
      const source = ER_LORE.sources[key];
      assert.ok(source);
      assert.match(source.checkedAt, /^2026-\d{2}-\d{2}$/);
      assert.ok(['playeternalreturn.com', 'event.playeternalreturn.com', 'game.naver.com'].includes(new URL(source.url).hostname));
    }
  }
});

test('ordinary chat, mere greetings, unrelated nearby words and system messages add no lore', () => {
  for (const text of ['일레븐 왔어? 반가워!', '비앙카, 거기 앉을래?', '커피 향 좋다', '빵 하나 놓고 수다 떨었네!', '다들 이 분위기 좋지?',
    '아디나, 카페 조명 예쁘다!', '비앙카 양산 접어둘까?', '일레븐, 너도 내 친구지!', '루치아 친구가 되어줘']) {
    assert.equal(eternalReturnContext([say(text)]), '');
  }
  assert.equal(eternalReturnContext([say('비앙카 안녕!'), say('우리 가족 얘기할게')]), '');
  assert.equal(eternalReturnContext([{from:'system',text:'세레스'}, ...Array(6).fill(say('안녕'))]), '');
  assert.equal(eternalReturnContext([say('세레스'), ...Array(6).fill(say('안녕'))]), '');
});

test('relations and IF take priority, with unsupported relationships explicitly distinguished', () => {
  const relation = eternalReturnContext([say('루치아와 세레스는 무슨 관계야?')]);
  assert.match(relation, /소중한 친구/);
  assert.match(relation, /확정 사망이라 하지 않는다/);
  assert.match(relation, /연인·배우자·혈족이라고 확정할 근거는 여기 없다/);
  const skin = eternalReturnContext([say('일레븐은 웨딩드레스 입었으니까 결혼한 거야?')]);
  assert.match(skin, /공식 IF/);
  assert.match(skin, /본편의 결혼·배우자 관계를 증명하지 않는다/);
  assert.match(ER_LORE_BASE, /원래 혈족·연인·절친이었다고 지어내지 않는다/);
  assert.match(ER_LORE_BASE, /팬 밈/);
});

test('only two recent matching cards at most, bounded even with source links; input unmodified', () => {
  const messages = [say('루미아 세계관'),say('비앙카 진조'),say('아디나 수정구'),say('루치아 세레스 관계 공식 자료 출처?')];
  const before = structuredClone(messages);
  const result = eternalReturnContext(messages);
  assert.ok(result.length <= 900);
  assert.ok((result.match(/\n- /g) || []).length <= 2);
  assert.match(result, /루치아와 세레스/);
  assert.match(result, /https:\/\/event.playeternalreturn.com/);
  assert.doesNotMatch(result, /비앙카의 배경|아디나의 배경/);
  assert.deepEqual(messages, before);
});

test('lore is in the real Korean prompt path without expanding every unrelated turn', () => {
  setLang('ko');
  const cfg = { roomName:'ERCraft', userName:'ERCraft', construction:false, agents:{} };
  assert.ok(buildBrief('claude',cfg).includes(ER_LORE_BASE));
  const messages = [ {id:1,ts:Date.now(),...say('루치아, 세레스랑 무슨 관계야?')} ];
  const store = { messages, after:()=>messages, recent:()=>messages, lastMessage:()=>messages.at(-1), readNote:()=>'', listFiles:()=>[] };
  const ctx = {store,cfg,agent:{seen:0},reason:'reply'};
  const turn = buildTurn('claude',ctx);
  assert.match(turn, /루치아와 세레스/);
  messages[0].text = '일레븐 어서 와!';
  assert.doesNotMatch(buildTurn('claude',ctx), /관련 설정 참고/);
});
