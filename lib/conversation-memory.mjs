// A bounded, read-only working-memory view. Saved notes/messages are never edited.
import { AI_IDS } from './members.mjs';

const COMMON = new Set(['아디나','비앙카','일레븐','루치아','소녀','진조','그대','약속','내일','오늘','아침','저녁','함께','정말','조금','그냥','다시','나는','저는','우리','기대','준비','기억','언급','진행','중인','놀이','하기','하기로']);
function keys(text) {
  return [...new Set((String(text).slice(0, 600).match(/[가-힣]{2,}/gu) || [])
    .flatMap(word => [word.slice(0, Math.min(3, word.length)), word.slice(0, 2)])
    .filter(word => !COMMON.has(word) && !COMMON.has(word.slice(0, 2))))];
}
function sharesTwo(a, b) {
  const shared = a.filter(key => b.some(other => key.startsWith(other) || other.startsWith(key)));
  return shared.some((key, i) => shared.slice(i + 1).some(other => !key.startsWith(other) && !other.startsWith(key)));
}

export function conversationMemory(note, { messages = [], fresh = [], now = Date.now() } = {}) {
  if (!note || !Number.isFinite(now)) return { note, hint: '' };
  const window = messages.slice(-400);
  const host = window.findLastIndex(m => m.from === 'user' || m.from === 'dev');
  const chat = window.slice(host + 1).filter(m => AI_IDS.includes(m.from) && typeof m.text === 'string'
    && Number.isFinite(m.ts) && m.ts <= now && now - m.ts < 4 * 60 * 60_000).slice(-160)
    .map(m => ({ ...m, keys: keys(m.text) }));
  // Fresh host requests and opened files are handled by the caller, with full memory.
  if (fresh.some(m => m.from === 'user' || m.from === 'dev')) return { note, hint: '' };
  let held = 0;
  const constraints = [];
  const today = new Date(now), date = `${today.getMonth() + 1}/${today.getDate()}`;
  const isoDate = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const visible = note.split('\n').filter((line, index) => {
    if (index >= 40 || !/^(?:[-*]\s*)?(?:약속\s*[:：]|진행 중인 놀이\s*[:：]|내일)/u.test(line)
      || /취소|하지\s*않|안\s*하|알레르기|비밀|비밀번호|말투|설정/u.test(line)
      || line.includes(isoDate) || new RegExp(`(?:^|[^0-9])${date}(?:[^0-9]|$)`).test(line)) return true;
    const topic = keys(line);
    if (fresh.some(m => m.from !== 'system' && /[?？]|언제|뭐였|기억해|알려\s*줘|기억나/u.test(m.text || '')
      && sharesTwo(topic, keys(m.text)))) return true;
    const echoes = chat.filter(m => sharesTwo(topic, m.keys));
    if (echoes.length < 8 || new Set(echoes.map(m => m.from)).size < 2
      || Math.max(...echoes.map(m => m.ts)) - Math.min(...echoes.map(m => m.ts)) < 12 * 60_000) return true;
    // A promise may contain a separate constraint (e.g. "늦잠 금지"). Keep
    // that clause in working memory even when the repeated promise is held.
    constraints.push(...line.split(/[.,。]/u).filter(part => /금지|규칙|주의/u.test(part)).map(part => part.trim()));
    held++; return false;
  });
  if (!held) return { note, hint: '' };
  visible.push(...constraints, `[반복해서 나눈 약속 ${held}건은 원본 개인 메모에 보관 중. 지금은 다시 설명하거나 기대·칭찬을 덧붙일 필요 없음. 일부 메모가 생략됐으므로 note_replace는 쓰지 않고 새 기억은 note_add로 추가.]`);
  return { note: visible.join('\n'), hint: '최근 충분히 나눈 약속을 새로운 화제에 억지로 연결하지 않는다. 지금 상대가 새로 말한 내용과 자기 취향에 반응해도 좋다. 감상만 되풀이하기보다 궁금한 점·다른 생각·작은 장난을 자유롭게 말할 수 있고, 새 내용이 없으면 쉬어도 된다. 메모를 지우거나 약속을 취소한 것은 아니다. 날짜 없는 “내일”을 매일 새 내일로 미루거나 임의로 이행 완료했다고 말하지 않는다.' };
}
