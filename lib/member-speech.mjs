// Literal boundaries are conservative: an unfinished quote, fence or link keeps
// the rest unchanged. Balanced links may contain parentheses in their URL.
function literalEnd(text, start) {
  const rest = text.slice(start);
  const fence = rest.match(/^(?:`+|~{3,})/)?.[0];
  if (fence) {
    if (fence.length >= 3) {
      const firstNewline = text.indexOf('\n', start + fence.length);
      if (firstNewline < 0) return text.length;
      // A block closes only on its own fence line, never inside code content.
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
      closing.lastIndex = firstNewline + 1;
      const end = closing.exec(text);
      return end ? end.index + end[0].length : text.length;
    }
    const closing = new RegExp(`(?<!\x60)\x60{${fence.length}}(?!\x60)`, 'g');
    closing.lastIndex = start + fence.length;
    const end = closing.exec(text);
    return end ? end.index + end[0].length : text.length;
  }
  const quote = { '"': '"', "'": "'", '“': '”', '‘': '’' }[text[start]];
  if (quote) {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === quote) return i + 1;
    }
    return text.length;
  }
  if (text[start] === '[') {
    let depth = 1, i = start + 1;
    for (; i < text.length && depth; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '[') depth++;
      else if (text[i] === ']') depth--;
    }
    if (depth) return text.length;
    if (text[i] !== '(') return i;
    depth = 1;
    for (i++; i < text.length && depth; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    return i;
  }
  const url = rest.match(/^https?:\/\/\S+/)?.[0];
  return url ? start + url.length : start;
}

function formatPlainSpeech(text) {
  return text.replace(/([ \t]*)ㅋ+([ \t]*)/gu, (_, before, after) => before && after ? before : '')
    // Observed conjugation mistakes, outside all literal/quotation boundaries.
    .replace(/(?<![\p{L}\p{N}_])같다(?:랄까나|달까나)(?=[!?.,~…]*(?:\s|$))/gu, '같달까나')
    .replace(/(?<![\p{L}\p{N}_])(써줘|적어줘|지켜보겠어|잊지 마|참아줘|이쪽으로 와)[ \t]*(?:랄까나|달까나)(?=[!?.,~…]*(?:\s|$))/gu, '$1')
    // Closed, owner-reported surface errors only: do not guess a whole sentence's meaning.
    .replace(/(?<![\p{L}\p{N}_])(수고해|부탁해|고마워요|고마워|축하해|잘 자|반가워|미안해|어서 와|와줘|해줘|있을게|해볼게|기다릴게|볼게|할게|갈게)[ \t]*(?:랄까나|달까나)(?=[!?.,~…]*(?:\s|$))/gu, '$1')
    .replace(/(?<![\p{L}\p{N}_])좋아해달까나(?=[!?.,~…]*(?:\s|$))/gu, '좋아한달까나')
    // Only a detached suffix after a complete ending. Valid predicates such as
    // 느낌이랄까나/신기하달까나 and unrelated whitespace are untouched.
    .replace(/([가-힣]+(?:네|데|거든|겠어|했어|왔어|봤어|봐|줄게|볼게|갈게|하자|해요))[ \t]+(?:랄까나|달까나)(?=[!?.,~…]*(?:\s|$))/gu, '$1');
}

// Surface-only preferences requested for Eleven. Never process actions/files/notes.
export function formatMemberSpeech(id, value) {
  const text = String(value ?? '');
  if (id !== 'claude') return text;
  const starts = /`+|~{3,}|["'“‘\[]|https?:\/\//gu;
  let result = '', last = 0, match;
  while ((match = starts.exec(text))) {
    const end = literalEnd(text, match.index);
    result += formatPlainSpeech(text.slice(last, match.index)) + text.slice(match.index, end);
    last = end;
    starts.lastIndex = end;
  }
  return result + formatPlainSpeech(text.slice(last));
}

// One deterministic participation lever: no message clipping, extra cooldown, or
// extra model call. Direct host requests do not consume a background opportunity.
export function takeParticipationTurn(state, rate = 1, directHostRequest = false) {
  if (directHostRequest) return true;
  const share = Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : 1;
  if (share === 1) return true;
  state.participationCredit = (state.participationCredit || 0) + share;
  if (state.participationCredit < 1 - Number.EPSILON) return false;
  state.participationCredit = Math.max(0, state.participationCredit - 1);
  return true;
}
