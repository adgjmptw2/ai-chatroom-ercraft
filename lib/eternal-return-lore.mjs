// Curated local facts only. No crawling, model calls or writes on conversation turns.
import fs from 'node:fs';

export const ER_LORE = JSON.parse(fs.readFileSync(new URL('./eternal-return-lore.json', import.meta.url), 'utf8'));
export const ER_LORE_BASE = '설정의 바탕은 이터널 리턴이다. 공식 배경·스킨 IF·팬 밈·이 방에서 생긴 추억은 구분한다. 물결마루 공동생활은 이 방의 각색이며, 입주자끼리 원래 혈족·연인·절친이었다고 지어내지 않는다. 현재 대화와 실제 기억으로 친분을 쌓고, 관련될 때만 설정을 자연스럽게 쓰며 모르는 관계는 단정하지 않는다.';
const RULES = {
  world: t => /루미아|아글라이아|생존실험|실험체.{0,16}(?:배경|세계관)|이터널\s*리턴.{0,16}세계관/u.test(t),
  adina: t => /아디나/u.test(t) && /수정구|점성|카페|별자리|배경|과거|친구|관계|세계관/u.test(t),
  bianca: t => /비앙카/u.test(t) && /흡혈귀|뱀파이어|진조|양산|전학생|배경|과거|가족|혈족|관계|세계관/u.test(t),
  eleven: t => /일레븐/u.test(t) && /방송|리뷰|채널|배경|과거|가족|친구|관계|세계관/u.test(t),
  lucia: t => /루치아|페란테/u.test(t) && /총사|머스킷|유모|가족|가문|배경|과거|관계|세계관/u.test(t),
  lucia_ceres: t => /세레스/u.test(t) || /루치아/u.test(t) && /친구|사용인|보석|브로치|관계/u.test(t),
  eleven_skin: t => /러블리\s*세레나데|러브\s*세레나데/u.test(t) || /일레븐/u.test(t) && /스킨|드레스|결혼|배우자|웨딩|IF/iu.test(t),
  nadja: t => /나쟈/u.test(t) && /오퍼레이터|공식|원래|배경|정체|관계/u.test(t),
};
const BACKGROUND = /설정|배경|세계관|과거|원래|공식|정체|누구|누가|관계|가족|가문|출신|사연|어쩌다|왜|채널\s*이름/u;

// Recent actual speech only; a plain greeting/name does not summon a biography.
// Score per message, not combined text: unrelated speakers' words cannot cross-match.
export function eternalReturnContext(messages = []) {
  const speech = messages.filter(m => m?.from !== 'system' && typeof m?.text === 'string')
    .slice(-6).map(m => m.text.slice(0, 1800));
  const hits = ER_LORE.cards.map(card => ({ card, at: speech.findLastIndex(t => RULES[card.id](t)
    && (['world','eleven_skin'].includes(card.id) || card.id === 'lucia_ceres' && /세레스/u.test(t) || BACKGROUND.test(t))) }))
    .filter(hit => hit.at >= 0).sort((a,b) => b.at - a.at ||
      Number(b.card.id === 'lucia_ceres' || b.card.id === 'eleven_skin') - Number(a.card.id === 'lucia_ceres' || a.card.id === 'eleven_skin'));
  if (!hits.length) return '';
  const cite = /출처|근거|공식\s*(?:자료|링크)|source/iu.test(speech.at(-1) || '');
  let out = '[관련 설정 참고 · 필요한 부분만 대화에 사용, 설명 의무 없음]';
  let count = 0;
  for (const { card } of hits) {
    const source = ER_LORE.sources[card.sources[0]];
    const kind = card.kind === 'official_if' ? '공식 IF' : source.kind === 'official_linked_database' ? '공식 연계 DB' : '공식 자료';
    const line = `\n- ${card.title} (${kind}, ${source.checkedAt} 확인): ${card.text}${cite ? ` 출처: ${source.url}` : ''}`;
    if (out.length + line.length > 900) continue;
    out += line;
    if (++count === 2) break;
  }
  return count ? out : '';
}
