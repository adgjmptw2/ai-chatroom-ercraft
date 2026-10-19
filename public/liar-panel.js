// Public spectator UI only. Personal predictions never leave this browser.
import { memberName, memberColor } from './persona-client.js';
import { getBasePath } from './base-path.js';

const LEAD = 10 * 60 * 1000;
const IDS = new Set(['adina', 'bianca', 'eleven', 'lucia']);
const PHASE = { clue: '단서', discussion: '질문·토론', vote: '비공개 투표', guess: '라이어의 정답 추측', finished: '종료' };
const OUTCOME = { citizens: '시민 승리', liar: '라이어 승리', draw: '무승부', cancelled: '게임 중단' };
const time = value => Number.isFinite(value) && value > 0 ? value : null;
const text = value => typeof value === 'string' ? value : '';
const node = (tag, className, value) => {
  const e = document.createElement(tag);
  e.className = className;
  if (value != null) e.textContent = value;
  return e;
};
const put = (e, value) => { if (e.textContent !== value) e.textContent = value; };
const publicPlayers = round => [...new Set((Array.isArray(round?.players) ? round.players : []).filter(id => IDS.has(id)))];
const submittedCount = (round, players) => new Set((Array.isArray(round?.submitted) ? round.submitted : []).filter(id => players.includes(id))).size;
const finished = round => round?.status === 'finished' && round.phase === 'finished';
const active = round => round?.status === 'active' && ['clue', 'discussion', 'vote', 'guess'].includes(round.phase);

export function createLiarPanel({ host, nameOf = memberName } = {}) {
  const root = node('details', 'liar-panel');
  root.setAttribute('aria-label', '라이어 게임 관전');
  const summary = node('summary', 'liar-summary');
  const title = node('strong', 'liar-title', '라이어 게임');
  const status = node('span', 'liar-status', '상태 확인 중');
  status.setAttribute('role', 'status');
  const schedule = node('span', 'liar-schedule');
  const banner = node('span', 'liar-banner');
  banner.hidden = true;
  const clock = node('span', 'liar-countdown');
  clock.setAttribute('role', 'timer');
  clock.setAttribute('aria-live', 'off');
  banner.append(document.createTextNode('곧 시작 · '), clock);
  summary.append(title, status, schedule, banner);
  const body = node('div', 'liar-body');
  const intro = node('p', 'liar-intro', '네 사람의 단서와 토론을 보고 라이어를 추리해 보세요. 역할과 정답은 게임이 끝난 뒤 공개됩니다.');
  const content = node('div', 'liar-content');
  body.append(intro, content);
  root.append(summary, body);
  if (host) host.append(root);
  else document.querySelector('.chat-head')?.after(root);

  const storageKey = `ercraft:liar:prediction:v1:${getBasePath() || '/'}`;
  let prediction = null, storageAvailable = true;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw && raw.length <= 1024) {
      const saved = JSON.parse(raw);
      if (saved?.version === 1 && typeof saved.roundId === 'string' && saved.roundId.length <= 160
        && IDS.has(saved.actor) && time(saved.startedAt) && time(saved.chosenAt)
        && Number.isSafeInteger(saved.revision) && saved.revision >= 0 && typeof saved.closed === 'boolean') {
        prediction = { version: 1, roundId: saved.roundId, actor: saved.actor, startedAt: saved.startedAt,
          chosenAt: saved.chosenAt, revision: saved.revision, closed: saved.closed };
      }
    }
    if (raw && !prediction) localStorage.removeItem(storageKey);
  } catch {
    try { localStorage.removeItem(storageKey); } catch { storageAvailable = false; }
  }

  let view = null, latest = null, offset = 0, timer = null, disposed = false;
  let roundId = null, signature = '', predictionLabel, choiceButtons = [];
  const now = () => Date.now() + offset;
  function persist() {
    try {
      if (prediction) localStorage.setItem(storageKey, JSON.stringify(prediction));
      else localStorage.removeItem(storageKey);
    } catch { storageAvailable = false; }
  }
  function matches(round) {
    return prediction && prediction.roundId === round?.id && prediction.startedAt === round.startedAt
      && publicPlayers(round).includes(prediction.actor) && prediction.chosenAt >= round.startedAt
      && prediction.chosenAt <= now() && prediction.revision <= view.revision;
  }
  function canChoose() {
    const round = view?.round, players = publicPlayers(round);
    return active(round) && ['clue', 'discussion', 'vote'].includes(round.phase)
      && typeof round.id === 'string' && round.id.length <= 160 && time(round.startedAt)
      && (!time(round.deadlineAt) || now() < round.deadlineAt)
      && !(round.phase === 'vote' && submittedCount(round, players) === players.length)
      && !prediction?.closed;
  }
  function person(id) {
    const e = node('span', 'liar-person', nameOf(id));
    e.style.setProperty('--liar-person-color', memberColor(id) || 'var(--muted)');
    return e;
  }
  function refreshPrediction() {
    if (!predictionLabel) return;
    const chosen = matches(view?.round) ? prediction.actor : null;
    for (const button of choiceButtons) {
      button.disabled = !canChoose();
      button.setAttribute('aria-pressed', String(chosen === button.dataset.actor));
    }
    const prefix = chosen ? `내 추측: ${nameOf(chosen)}. ` : '아직 고르지 않았어요. ';
    put(predictionLabel, prefix + (canChoose() ? '투표가 끝나기 전까지 바꿀 수 있어요.' : '추측이 마감되었습니다.'));
    if (!storageAvailable) put(content.querySelector('.liar-local-note'), '브라우저 저장을 사용할 수 없어 이 화면에서만 유지됩니다. AI에게 전달되지 않아요.');
  }
  function renderRound() {
    content.replaceChildren();
    predictionLabel = null; choiceButtons = [];
    const round = view?.round;
    if (!round || (!active(round) && !finished(round))) return;
    const players = publicPlayers(round);
    const progress = node('p', 'liar-progress');
    const step = Number.isSafeInteger(round.step) && round.step >= 0 ? round.step : null;
    const total = Number.isSafeInteger(round.totalSteps) && round.totalSteps > 0 ? round.totalSteps : null;
    progress.textContent = `${PHASE[round.phase]}${step !== null && total !== null ? ` · ${Math.min(step, total)}/${total}단계` : ''}`;
    if (active(round) && players.includes(round.turn)) progress.append(' · 현재 차례: ', person(round.turn));
    else if (active(round)) progress.append(' · 다음 진행 대기');
    content.append(node('p', 'liar-category', `주제: ${text(round.category) || '아직 공개되지 않음'}`), progress);

    if (round.phase === 'vote') {
      content.append(node('p', 'liar-vote-progress', `투표 제출 ${submittedCount(round, players)}/${players.length}명 · 누구를 골랐는지는 종료 후 공개`));
    }
    const clues = (Array.isArray(round.clues) ? round.clues : []).filter(c => c && players.includes(c.actor) && ['clue', 'discussion'].includes(c.phase)).slice(0, 16);
    const list = node('ol', 'liar-clues');
    list.setAttribute('aria-label', '공개 단서와 질문·토론');
    for (const clue of clues) {
      const item = node('li', 'liar-clue');
      const label = node('div', 'liar-clue-label');
      label.append(person(clue.actor), ` · ${PHASE[clue.phase]}`);
      item.append(label, node('p', '', text(clue.text)));
      list.append(item);
    }
    if (clues.length) content.append(list);
    else if (active(round)) content.append(node('p', 'liar-empty', '첫 단서를 기다리고 있어요.'));

    if (active(round)) {
      const group = node('fieldset', 'liar-prediction');
      group.append(node('legend', '', '내가 생각하는 라이어'));
      const buttons = node('div', 'liar-choices');
      for (const id of players) {
        const button = node('button', 'liar-choice');
        button.type = 'button'; button.dataset.actor = id;
        button.append(person(id));
        button.onclick = () => {
          if (!canChoose()) return;
          prediction = { version: 1, roundId: round.id, actor: id, startedAt: round.startedAt,
            chosenAt: now(), revision: view.revision, closed: false };
          persist(); refreshPrediction();
        };
        choiceButtons.push(button); buttons.append(button);
      }
      predictionLabel = node('p', 'liar-prediction-status');
      predictionLabel.setAttribute('role', 'status');
      group.append(buttons, predictionLabel, node('p', 'liar-local-note', storageAvailable
        ? '이 브라우저에만 저장됩니다. 실제 투표나 AI 대화에는 전달되지 않아요.'
        : '브라우저 저장을 사용할 수 없어 이 화면에서만 유지됩니다. AI에게 전달되지 않아요.'));
      content.append(group); refreshPrediction();
      return; // Never read result/word/role/votes from an active round.
    }

    const result = round.result;
    if (!result || !Object.hasOwn(OUTCOME, result.outcome)) {
      content.append(node('p', 'liar-result-pending', '게임이 종료되었습니다. 공개 결과를 기다리고 있어요.'));
      return;
    }
    const reveal = node('section', 'liar-result');
    reveal.setAttribute('aria-label', '실제 게임 결과');
    reveal.append(node('h3', '', OUTCOME[result.outcome]));
    if (text(result.reason)) reveal.append(node('p', '', result.reason));
    if (players.includes(result.liar)) {
      const role = node('p', 'liar-reveal-role', '라이어: ');
      role.append(person(result.liar)); reveal.append(role);
    }
    if (text(result.word)) reveal.append(node('p', 'liar-reveal-word', `정답: ${result.word}`));
    if (text(result.guess)) reveal.append(node('p', 'liar-reveal-guess', `라이어의 마지막 추측: ${result.guess}`));
    const seen = new Set();
    const votes = (Array.isArray(result.votes) ? result.votes : []).filter(v => {
      if (!v || !players.includes(v.actor) || !players.includes(v.target) || seen.has(v.actor)) return false;
      seen.add(v.actor); return true;
    });
    if (votes.length) {
      const tally = node('p', 'liar-tally', '공개된 득표: ');
      players.forEach((id, i) => tally.append(i ? ' · ' : '', `${nameOf(id)} ${votes.filter(v => v.target === id).length}표`));
      const ballot = node('ul', 'liar-ballots');
      for (const vote of votes) ballot.append(node('li', '', `${nameOf(vote.actor)} → ${nameOf(vote.target)}`));
      reveal.append(tally, ballot);
    }
    const eligible = matches(round) && prediction.revision < view.revision;
    let verdict = eligible ? `내 추측: ${nameOf(prediction.actor)}. ` : '이번 게임은 마감 전에 고른 추측이 없습니다.';
    if (eligible && result.outcome !== 'cancelled' && players.includes(result.liar)) {
      verdict += prediction.actor === result.liar ? '라이어를 맞혔어요!' : '이번에는 빗나갔어요.';
    } else if (eligible) verdict += '추측 결과는 판정하지 않습니다.';
    reveal.append(node('p', 'liar-verdict', verdict)); content.append(reveal);
  }

  function tick() {
    clearTimeout(timer); timer = null;
    if (disposed) return;
    const next = time(view?.nextStartAt), current = now(), round = view?.round;
    const playing = active(round);
    const warningAt = next === null ? null : Math.max(next - LEAD, time(view?.noticeAt) ?? next - LEAD);
    const warning = !playing && next !== null && current >= warningAt && current < next;
    banner.hidden = !warning;
    root.classList.toggle('liar-warning', warning);
    if (warning) {
      const seconds = Math.max(0, Math.ceil((next - current) / 1000));
      put(clock, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
    }
    put(schedule, next !== null
      ? `다음 예정 · ${new Date(next).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`
      : '다음 일정 확인 중');
    let label = !view ? '상태를 확인할 수 없어요' : playing ? PHASE[round.phase]
      : finished(round) ? '지난 게임 결과' : '다음 게임 대기';
    if (playing && publicPlayers(round).includes(round.turn)) label += ` · ${nameOf(round.turn)} 차례`;
    if (!playing && next !== null && current >= next) label += ' · 시작 여부 확인 중';
    put(status, label);
    if (view && prediction && !prediction.closed && !canChoose()) { prediction.closed = true; persist(); }
    refreshPrediction();
    if (document.hidden) return;
    // Only the ten-minute banner ticks each second. Far-away schedules use one
    // wakeup at noticeAt; there is no polling and no automatic game transition.
    if (warning) timer = setTimeout(tick, Math.min(1000, next - current));
    else if (!playing && warningAt !== null && warningAt > current) timer = setTimeout(tick, Math.min(warningAt - current, 2147483647));
    else if (playing && time(round.deadlineAt) > current) timer = setTimeout(tick, Math.min(round.deadlineAt - current, 2147483647));
  }

  function update(value) {
    if (disposed) return;
    const valid = value?.version === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 && time(value.serverNow);
    if (valid && latest && (value.revision < latest.revision || value.revision === latest.revision && value.serverNow < latest.serverNow)) return;
    view = valid ? value : null;
    if (view) {
      // Identity refreshes may reuse the last view. Do not rewind its clock or
      // invalidate a choice made after that snapshot was first received.
      if (!latest || view.serverNow !== latest.serverNow) offset = view.serverNow - Date.now();
      latest = { revision: view.revision, serverNow: view.serverNow };
    }
    const round = view?.round;
    if (view && prediction && !matches(round)) { prediction = null; persist(); }
    if (view && (round?.id ?? null) !== roundId) {
      roundId = round?.id ?? null;
      root.open = false; // New games stay compact until the viewer expands them.
    }
    // serverNow changes must not replace buttons, scroll position or focus.
    const nextSignature = JSON.stringify([round, view?.revision, publicPlayers(round).map(id => [id, nameOf(id), memberColor(id)])]);
    if (signature !== nextSignature) {
      const focus = content.contains(document.activeElement) ? document.activeElement?.dataset.actor : null;
      const scroll = body.scrollTop;
      signature = nextSignature; renderRound();
      body.scrollTop = scroll;
      if (focus) choiceButtons.find(b => b.dataset.actor === focus && !b.disabled)?.focus({ preventScroll: true });
    }
    tick();
  }
  document.addEventListener('visibilitychange', tick);
  update(null);
  return {
    update,
    dispose() {
      disposed = true; clearTimeout(timer); timer = null;
      document.removeEventListener('visibilitychange', tick);
      root.remove();
    },
  };
}
