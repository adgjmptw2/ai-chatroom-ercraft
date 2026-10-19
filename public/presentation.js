// Display-only adapters for structured UI metadata. Never mutate state/history or
// pass ordinary chat, personal notes, or explicit model answers through these.

// Fail closed until an authenticated admin session has been confirmed by HTTP.
export function sessionView(session) {
  const admin = session?.role === 'admin' && session.authenticated === true;
  return { role: admin ? 'admin' : 'viewer', authenticated: admin };
}

// The server derives this solely from member/room activity. Whitelist its
// public states; unknown or older payloads never imply a different condition.
export function sleepView(condition, t) {
  const state = ['awake', 'resting', 'asleep', 'unknown'].includes(condition?.state) ? condition.state : 'unknown';
  return { state, label: t(`sleep.${state}`) };
}

export function systemText(message, name, t) {
  const text = String(message.text ?? '');
  // Only the server's boostOn templates carry a routing label in system text.
  // Reasons can quote model names too; use the localized event label, retaining
  // the full original reason and model in the message and server diagnostics.
  if (message.from === 'system' && message.kind === 'deep' && message.by
      && /^🔥 [^\r\n]+ (?:진심모드|Boost mode|本気モード) — [^\r\n]+ · [\s\S]*$/.test(text)) {
    return t('boost.notice', { name });
  }
  return text;
}

// Allow only neutral presentation labels. Unknown provider-supplied labels use
// generic copy; ids, percentages, timestamps, deltas and series stay untouched.
const NEUTRAL_WINDOW = /^(?:\d+(?:\.\d+)?\s*(?:시간|일|h|d|hours?|days?|時間|日)|주간(?: 크레딧)?|월간(?: 크레딧)?|크레딧|weekly(?: credits)?|monthly(?: credits)?|credits|週間(?:クレジット)?|月間(?:クレジット)?|クレジット)$/i;
export function quotaLabel(window, t) {
  const id = String(window.id ?? '');
  if (id.startsWith('week-')) return `${t('usage.week')} · ${t('usage.additional')}`;
  const label = String(window.label ?? '').trim();
  if (NEUTRAL_WINDOW.test(label)) return label;
  const period = { '5h': 'usage.fiveHours', week: 'usage.week', month: 'usage.month' }[id];
  if (period) return t(period) + (window.minor ? ` · ${t('usage.additional')}` : '');
  return t(window.minor ? 'usage.additional' : 'usage.quota');
}

export function quotaPlan(plan, t) {
  if (!plan) return '';
  const text = String(plan).trim();
  return /^(?:Pro Lite|Pro|Plus|Team|Business|Enterprise|Free|구독|Subscription|サブスクリプション|サブスク)$/i.test(text)
    ? text : t('usage.plan');
}

export function quotaNote(note, t) {
  if (!note) return '';
  const text = String(note).trim();
  if (/^(?:지출 한도 도달|한도 도달|Spend limit reached|Limit reached|支出上限に到達|上限に到達|(?:종량제|Pay as you go|従量課金) [\d.]+ \/ [\d.]+)$/i.test(text)) return text;
  return t('usage.details');
}
