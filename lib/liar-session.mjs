import { parseLiarTurn } from './liar-turn.mjs';

// One reserved provider call at a time. Only the engine's public projection leaves here.
export class LiarSession {
  constructor(engine, { now = Date.now, call, canRun, speech, notice, change, prepare = (_actor, text) => text,
    beforeSubmit = async () => {}, settled = () => {}, onError = () => {}, onDiagnostic = () => {} }) {
    Object.assign(this, { engine, now, call, canRun, speech, notice, change, prepare, beforeSubmit, settled, onError, onDiagnostic });
    this.busy = false;
    // A reconstructed session cannot know the consumed budget. Fail closed for
    // that round without changing the persisted schema or resuming a claim.
    this.repairRound = engine?.view(now()).round?.id ?? null;
    this.repairs = this.repairRound ? 2 : 0;
  }
  view() { return this.engine?.view(this.now()) ?? { unavailable: true }; }
  disable() { this.engine = null; this.onError(); this.change(this.view()); }
  publish(update) {
    if (!update?.changed) return;
    if (update.speech) this.speech(update.speech);
    for (const text of update.notices || []) this.notice(text);
    this.change(this.view());
  }
  tick(options) {
    if (!this.engine) return false;
    try {
      this.publish(this.engine.advance(this.now(), options));
      const active = this.view().round?.status === 'active';
      if (active && !this.busy && this.canRun()) {
        const ticket = this.engine.pending(this.now());
        if (ticket) {
          const reservation = this.engine.claim(ticket, this.now());
          if (reservation.ok) {
            this.busy = true;
            this.change(this.view());
            this.task = this.run(ticket.actor, reservation.token);
          }
        }
      }
      return active || this.busy;
    } catch { this.disable(); return this.busy; }
  }
  async run(actor, token) {
    try {
      const context = this.engine.context(actor, token);
      if (!context || !this.canRun()) { this.publish(this.engine.fail(token, actor, this.now())); return; }
      if (this.repairRound !== context.roundId) { this.repairRound = context.roundId; this.repairs = 0; }
      const diagnostic = reason => {
        try { this.onDiagnostic({ reason, phase: context.phase }); } catch { /* telemetry cannot affect play */ }
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        // Check the original reservation before every dispatch, including repair.
        const live = this.engine.assess(token, actor, { op: 'decline' }, this.now());
        if (!this.canRun() || !live.ok) {
          diagnostic(!this.canRun() ? 'stopped' : live.reason);
          this.publish(this.engine.fail(token, actor, this.now())); return;
        }
        const card = structuredClone(context);
        if (attempt) card.correction = '이전 응답을 사용할 수 없습니다. 현재 phase에 맞는 JSON 객체 하나를 새로 작성하세요. 단서·토론은 정답이나 별칭·철자 공개 없이 짧은 간접 표현을 쓰세요. 투표는 choices 중 하나를 고르세요. 참여를 원하지 않으면 decline을 선택하세요.';
        const response = await this.call(actor, card);
        if (!this.engine) return;
        if (!this.canRun() || !response?.ok) {
          diagnostic(!this.canRun() ? 'stopped' : 'provider_failure');
          this.publish(this.engine.fail(token, actor, this.now())); return;
        }
        let action = parseLiarTurn(response.text);
        if (action && ['clue', 'discussion'].includes(action.op)) action = { ...action, text: this.prepare(actor, action.text) };
        const check = this.engine.assess(token, actor, action, this.now());
        if (!check.ok) {
          diagnostic(check.reason);
          if (!attempt && this.repairs < 2 && ['invalid_action', 'answer_leak'].includes(check.reason)) {
            this.repairs++;
            continue;
          }
          this.publish(this.engine.fail(token, actor, this.now())); return;
        }
        // Only an assessed, final formatted candidate reaches typing/pacing.
        if (action && ['clue', 'discussion'].includes(action.op)) await this.beforeSubmit(actor, action.text);
        if (!this.engine) return;
        if (!this.canRun()) { this.publish(this.engine.fail(token, actor, this.now())); return; }
        this.publish(this.engine.submit(token, actor, action, this.now()));
        return;
      }
    } catch {
      try { if (this.engine) this.publish(this.engine.fail(token, actor, this.now())); }
      catch { this.disable(); }
    } finally { this.busy = false; this.settled(actor); }
  }
}
