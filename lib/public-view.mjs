// Browser responses are read-only projections, including for logged-in admins.
import { defaultPublicIdentity, publicId } from './public-identity.mjs';
const fields = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
export const publicRoom = (value, privacy = defaultPublicIdentity) => privacy.project(fields(value, ['running','sleeping','roomName','userName','lang','dev']));
export function publicMember(value, privacy = defaultPublicIdentity) {
  const out = fields(value, ['id','name','color','accentColor','status','drawing','enabled','available','deep']);
  if (value.aliases) out.aliases = value.aliases.filter(a => typeof a === 'string' && !privacy.contains(a));
  if (value.persona) {
    out.persona = fields(value.persona, ['name','look']);
    if (value.persona.skin) out.persona.skin = fields(value.persona.skin, ['key','label','full','avatar','avatarCrop']);
  }
  return privacy.project(out);
}

export function batteryView(usage, ids, now = Date.now()) {
  return Object.fromEntries(ids.map(rawId => {
    const id = publicId(rawId);
    const u = usage?.[rawId];
    const windows = (u?.windows || []).filter(w => !w.minor && Number.isFinite(w.remainingPct));
    if (!windows.length) return [id, { level: null, state: u?.ok === false ? 'error' : 'unknown' }];
    const stale = u.ok === false || u.restored || !Number.isFinite(u.at) || now - u.at > 20 * 60000;
    if (stale) return [id, { level: null, state: 'stale' }];
    const remaining = Math.max(0, Math.min(100, ...windows.map(w => w.remainingPct)));
    return [id, { level: remaining === 0 ? 0 : Math.ceil(remaining / 25), state: 'ready' }];
  }));
}

// Actual activity only. Never derive public sleep labels from quota/account data.
export function sleepStates(members) {
  return Object.fromEntries(members.map(member => {
    const state = member.enabled === false || ['off', 'away'].includes(member.status) ? 'resting'
      : member.status === 'sleeping' ? 'asleep'
      : ['idle', 'reading', 'typing'].includes(member.status) ? 'awake' : 'unknown';
    return [publicId(member.id), { state }];
  }));
}

const PLAN_ERRORS = {
  planner_busy: '다른 설계 요청을 처리하고 있습니다. 이 요청은 접수되지 않았습니다. 처리 완료 후 다시 요청해 주세요.',
  member_queue_full: '해당 멤버의 설계 요청이 이미 대기 또는 처리 중입니다. 완료를 기다리거나 기존 요청을 취소해 주세요.',
  queue_full: '설계 대기열이 가득 찼습니다. 기존 요청이 완료된 후 다시 요청해 주세요.',
  request_quota: '현재 설계 요청 한도에 도달했습니다. 잠시 후 다시 요청해 주세요.',
  request_cooldown: '설계 요청 대기 시간이 남아 있습니다.',
  member_cooldown: '해당 멤버의 설계 요청 대기 시간이 남아 있습니다.',
  stage_cooldown: '다음 시공 단계까지 대기 중입니다.',
  stage_order: '현재 진행할 수 없는 시공 단계입니다. 최신 설계 진행 상태를 확인해 주세요.',
  plan_preparing: '설계가 진행 중입니다. 완료 후 시공할 수 있습니다.',
  plan_paused: '이어 짓기가 일시정지되었습니다.',
  continuation_owner: '예약자 또는 설계자만 이어 짓기 설정을 변경할 수 있습니다.',
  site_changed: '예약 부지가 변경되어 작업을 중단했습니다. 기존 건축물은 보존되었습니다.',
  planner_failed: '설계 요청을 완료하지 못했습니다. 요청 내용을 확인한 후 다시 시도해 주세요.',
  planner_timeout: '설계 응답 대기 시간이 초과되었습니다. 기존 처리의 종료를 확인한 후 다시 요청해 주세요.',
  planner_interrupted: '설계 처리가 중단되었습니다. 실행 상태를 확인해야 합니다.',
  planner_persist_failed: '설계 진행 기록을 저장하지 못했습니다. 관리자의 확인이 필요합니다.',
  planner_claim_failed: '설계 실행 예약을 저장하지 못했습니다. 관리자의 확인이 필요합니다.',
  planner_unavailable: '설계 서비스에 연결할 수 없습니다. 관리자의 확인이 필요합니다.',
  invalid_recipe: '설계 결과가 건축 규칙에 맞지 않습니다. 요청 내용을 수정해 주세요.',
  room_stopped: 'ERCraft AI 단톡방이 현재 오프라인입니다. 기존 설계 대기열은 보존됩니다.',
  plan_io_error: '월드 또는 진행 기록을 저장하지 못했습니다. 관리자의 확인이 필요합니다.',
};

export function publicSystemText(message, lang = 'ko') {
  const text = String(message.text ?? '');
  if (message.from !== 'system') return text;
  if (message.kind === 'deep') return lang === 'ko' ? '멤버가 진심모드로 응답하고 있습니다.' : lang === 'ja' ? 'メンバーが本気モードで応答しています。' : 'A member is responding in focused mode.';
  if (message.kind === 'error') {
    if (lang !== 'ko') return lang === 'ja' ? '処理を完了できませんでした。状態を確認してください。' : 'The request could not be completed. Please check its status.';
    if (text.startsWith('블록은 보존됐지만 진행 기록 확인이 필요해.')) return '블록은 보존되었지만 진행 기록 확인이 필요합니다.';
    const missing = text.match(/^(?:일레븐|아디나|비앙카|루치아)(?:이|가)? (?:보여주려던 (.+) 파일이 없어|첨부 파일을 찾을 수 없습니다: (.+))$/);
    if (missing) return `첨부 파일을 찾을 수 없습니다: ${missing[1] || missing[2]}`;
    const reason = PLAN_ERRORS[message.planError?.code] || '요청을 처리하지 못했습니다. 관리자가 연결 및 작업 상태를 확인해 주세요.';
    const wait = message.planError?.retryAfterSec;
    return reason + (Number.isFinite(wait) && wait > 0 ? ` 대기 시간: ${Math.ceil(wait)}초.` : '');
  }
  if (lang !== 'ko') return text;
  // Known system templates only. Saved messages and character speech stay intact.
  if (message.kind === 'welcome') return 'ERCraft 단톡방에 오신 것을 환영합니다.';
  if (message.kind === 'sleep') return 'ERCraft AI 단톡방이 현재 대기 중입니다. 관리자가 대화를 재개할 수 있습니다.';
  if (message.kind === 'reset' && text === '대화와 월드를 새로 시작했어.') return '대화와 월드를 새로 시작했습니다.';
  if (message.kind === 'dev') return message.online ? '나쟈 개발 세션이 연결되었습니다.' : '나쟈 개발 세션 연결이 종료되었습니다.';
  if (message.kind === 'world' || message.kind === 'info') return text
    .replace(/\s*(?:차례가 오면 자동으로 설계해\. 다시 요청할 필요는 없어\.|차례가 되면 자동으로 설계합니다\. 다시 요청하지 않으셔도 됩니다\.)/g, '')
    .replace('설계 준비 완료 · 아직 짓지 않았어', '설계 준비 완료 · 시공 전')
    .replace('부지 확인이 필요해', '부지 확인 필요')
    .replace('이미 완료한 단계야.', '이미 완료된 단계입니다.')
    .replace('모든 단계가 끝났어.', '모든 단계가 완료되었습니다.')
    .replace(/단계, (\d+)초 뒤 stage:"next"를 선택해\./g, '단계입니다. $1초 후 다음 단계를 진행할 수 있습니다.');
  return text
    .replace(/ 보여주려던 (.+) 파일이 없어$/, ' 첨부 파일을 찾을 수 없습니다: $1')
    .replace(/ 들어옴(?: \(개발 세션 연결\))?$/, ' 님이 입장했습니다.')
    .replace(/ 잠깐 나감$/, ' 님이 퇴장했습니다.')
    .replace(/ 쌓여서 (.+) 말할 때까지 다들 잠깐 쉬어$/, ' 누적으로 대화를 잠시 중지했습니다. $1 대화하면 재개됩니다.');
}

export function publicMessage(message, lang = 'ko', privacy = defaultPublicIdentity, publicPath = value => privacy.contains(value) ? null : value) {
  const value = fields(message, ['id','ts','from','kind','by','replyTo','file','online','deep','sticker','reactions','continuation']);
  value.text = publicSystemText(message, lang);
  if (message.attach) value.attach = fields(message.attach, ['path','desc','sticker','upload']);
  if (value.file) value.file = publicPath(value.file);
  if (value.attach?.path) value.attach.path = publicPath(value.attach.path);
  return privacy.project(value);
}

export function publicPlans(view, privacy = defaultPublicIdentity) {
  return privacy.project({ plans: (view.plans || []).map(p => fields(p, ['id','ref','owner','title','status','site','bbox','count','stages','completedStages','nextStage','builtCells','queued','queuePosition','preparing'])),
    pending: !!view.pending });
}

export function publicEvent(type, data, lang = 'ko', privacy = defaultPublicIdentity, publicPath) {
  if (type === 'usage' || type === 'batteries') return null;
  if (type === 'sleeps') return Object.fromEntries(Object.entries(data).map(([id, value]) => [publicId(id), {
    state: ['awake', 'resting', 'asleep', 'unknown'].includes(value?.state) ? value.state : 'unknown',
  }]));
  if (type === 'room') return publicRoom(data, privacy);
  if (type === 'members') return data.map(m => publicMember(m, privacy));
  if (type === 'msg' || type === 'msgupdate') return publicMessage(data, lang, privacy, publicPath);
  if (type === 'plans') return publicPlans(data, privacy);
  if (type === 'world') return privacy.world(data);
  if (type === 'living' || type === 'liar') return privacy.project(data);
  if (type === 'worldblocks') return privacy.world({ custom: data }).custom;
  if (['ws','notes','avatars','signs'].includes(type)) return privacy.project(data);
  return null;
}
