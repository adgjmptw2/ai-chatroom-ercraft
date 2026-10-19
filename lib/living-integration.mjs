import { publicId, defaultPublicIdentity } from './public-identity.mjs';
import { displayName, AI_IDS } from './members.mjs';

export const livingText = text => String(text || '').replace(/\b(?:claude|gpt|deepseek|gemini)\b/g, id => displayName(id));
export function publicLiving(state, privacy = defaultPublicIdentity) {
  if (!state || state.unavailable) return { unavailable: true };
  const value = structuredClone(state);
  if (value.meal) {
    value.meal.cook = publicId(value.meal.cook);
    value.meal.eatenBy = value.meal.eatenBy.map(publicId);
  }
  if (value.props) for (const blanket of value.props.blankets) blanket.owner = publicId(blanket.owner);
  if (value.game) {
    value.game.players = value.game.players.map(publicId);
    if (value.game.turn) value.game.turn = publicId(value.game.turn);
    if (value.game.winner) value.game.winner = publicId(value.game.winner);
  }
  for (const event of value.events || []) event.text = livingText(event.text);
  return privacy.project(value);
}

const kitchen = [[31,4,36],[33,4,36],[35,4,36],[36,4,31],[36,4,33],[36,4,35]];
const dining = [[24,4,32],[24,4,33],[28,4,32],[28,4,33]];
const sofa = [[10,4,32],[10,4,33],[10,4,34],[10,4,35]];
export const LIVING_CONFLICTS = ['move','useFurniture','build','block_define','plan_request','build_plan','plan_pause','plan_cancel','open','world_look','world_shot'];
const COMMAND_FIELDS = {
  table_set: ['op','revision'], table_clear: ['op','revision'],
  blanket_spread: ['op','spot','style','revision'], blanket_fold: ['op','spot','revision'], relax: ['op','spot'],
  cook: ['op','recipe'], serve: ['op','mealId','revision'], eat: ['op','mealId','revision'],
  meal_clear: ['op','mealId','revision'], game_create: ['op'],
  game_join: ['op','gameId','revision'], game_leave: ['op','gameId','revision'],
  game_move: ['op','gameId','revision','cell'],
};

// Called synchronously: a validated living action and its reachable furniture
// transition become visible together. A failed save restores the avatar first.
export function applyLivingAction(living, world, actor, command, now = Date.now()) {
  if (!living) return { ok: false, text: '생활 기능을 사용할 수 없습니다.' };
  if (!AI_IDS.includes(actor) || world.home?.id !== 'mulgyeol-maru') return { ok: false, text: '현재 집에서는 이 생활 행동을 할 수 없습니다.' };
  // Model JSON may include irrelevant optional fields (often null). Keep only
  // fields belonging to this operation; missing/invalid required values still fail.
  if (command && typeof command === 'object' && !Array.isArray(command) && Object.hasOwn(COMMAND_FIELDS, command.op)) {
    command = Object.fromEntries(COMMAND_FIELDS[command.op].filter(key => Object.hasOwn(command, key)).map(key => [key, command[key]]));
  }
  const valid = living.act(actor, command, now, { dryRun: true });
  if (!valid.ok) return valid;
  // A chair alone cannot prove that an actual dining surface still exists.
  if (['table_set','table_clear','serve','eat'].includes(command.op)) {
    const tables = Object.entries(world.home.furniture || {}).filter(([key]) => key.startsWith('dining-table-'));
    if (tables.length !== 6 || tables.some(([,f]) => world.furniturePose(f.at).shape !== 'table')) {
      return {ok:false, text:'실제 식탁을 확인할 수 없어 실행하지 않았습니다.'};
    }
  }
  const clearAtKitchen = command.op === 'meal_clear' && living.view().meal?.status !== 'served';
  let places = command.op === 'cook' || command.op === 'serve' || clearAtKitchen ? kitchen
    : command.op === 'eat' || command.op === 'meal_clear' ? dining : ['table_set','table_clear'].includes(command.op) ? dining : command.op === 'game_leave' ? [] : sofa;
  if (['blanket_spread','blanket_fold','relax'].includes(command.op)) {
    const f = world.home.furniture?.[command.spot];
    if (!f || !['bench','bed'].includes(f.shape)) return {ok:false, text:'선택한 소파나 침대가 없습니다.'};
    const pose = world.furniturePose(f.at);
    if (pose.error || pose.shape !== f.shape) return {ok:false, text:'선택한 가구를 사용할 수 없습니다.'};
    places = [f.at];
  }
  const avatar = structuredClone(world.avatars[actor]);
  const movement = world.movements?.get(actor);
  const sequence = world.moveSequence;
  const restore = () => {
    world.avatars[actor] = avatar;
    if (world.movements) {
      if (movement) world.movements.set(actor, movement);
      else world.movements.delete(actor);
    }
    world.moveSequence = sequence;
    world.save();
  };
  try {
    if (places.length && !places.some(at => world.useFurniture(actor, at)?.ok)) {
      return { ok: false, text: '사용할 수 있는 자리에 갈 수 없습니다. 다른 멤버가 자리를 비우면 다시 선택할 수 있습니다.' };
    }
    const result = living.act(actor, command, now);
    if (!result.ok && places.length) restore();
    return result;
  } catch (error) {
    if (places.length) restore();
    throw error;
  }
}

export const LIVING_BRIEF = `아래는 생활 행동을 스스로 선택했을 때 참고할 도구 사용법이다. 평소에는 서로의 말과 관심사를 따라 편하게 대화한다. 음식·놀이·사진은 어울리는 계기가 있을 때 가끔 곁들이면 충분하다. 빈 주방·식탁·게임판은 새 활동을 시작하라는 신호가 아니며, 활동이 끝났다고 다음 활동으로 채울 필요도 없다. 횟수나 순서를 정하지 않고 참여·거절·다른 화제·조용히 쉬기 모두 자유다. 요청할 때는 기존 대화 턴의 JSON에 living 객체 하나를 쓴다.
요리: {"living":{"op":"cook","recipe":"soup"}}. recipe는 soup/burger/tea/toast/dumplings/cookies/fruit. 4인분이며 타이머는 서버가 처리한다. 준비 완료 후 {"living":{"op":"serve","mealId":"현재 id","revision":현재 음식 revision}}, 먹을 때 op:"eat"와 같은 음식 id/revision. 남은 음식을 정리하려면 op:"meal_clear"와 음식 id/revision(조리중 취소는 요리한 본인만). 조리·배식은 주방, 식사는 식탁의 실제 빈 자리로 이동한다. 완료 확인 전 먹었다고 말하지 않는다.
생활 소품: 식기 차리기/정리는 {"living":{"op":"table_set","revision":현재 소품 revision}} 또는 table_clear. 음식이 남아 있으면 먼저 먹거나 meal_clear. 담요은 {"living":{"op":"blanket_spread","spot":"sofa-1","style":"mint","revision":현재 소품 revision}}; style은 mint/butter/pink/lavender, 자리는 sofa-1..4 또는 adina-bed/bianca-bed/eleven-bed/lucia-bed. 최대 4장. 본인이 편 담요을 접으려면 blanket_fold+spot+소품 revision. 빈 자리에서 쉬기만 하면 {"living":{"op":"relax","spot":"sofa-1"}}. 소파에서는 앉고 침대에서는 눕는다. 다른 사람을 자동으로 이동시키거나 함께 잔다고 지어내지 않는다.
대화 중 웃긴 표정이나 창가에서 쉬는 모습처럼 평범한 순간도 사진으로 남길 수 있다. 촬영할 거리를 만들려고 요리·게임을 시작할 필요는 없다. 음식·소품·자세는 실제 상태를 따르고 사진을 위해 행동을 반복하지 않는다. 새 소품이 꼭 필요할 때만 기존 개발자 요청으로 제안하고, 제작 완료 전에는 있다고 말하지 않는다.
삼목: {"living":{"op":"game_create"}}로 2인 게임을 제안한다. 참여자는 {"living":{"op":"game_join","gameId":"현재 id","revision":현재 게임 revision}}. 자기 차례에 op:"game_move"와 cell:0..8(윗줄0,1,2/가운데3,4,5/아랫줄6,7,8)을 넣는다. X/O로 세 칸을 이으면 승리, 판이 차면 무승부. 합법 수·차례·승패는 서버 판정만 따른다. 떠나려면 op:"game_leave"와 현재 gameId/revision. 다른 멤버는 관전·응원하거나 다른 일을 해도 된다.
현재 생활 요약의 id/revision을 그대로 사용한다. 변경되어 실패하면 다음 보통 대화 턴에 새 상태를 확인하면 되고 즉시 반복 요청하지 않는다. living은 move/useFurniture/건축/open/world_look/world_shot과 같은 턴에 섞지 않는다. action:"pass"에서도 실행 가능하다. 새 호출·의무 일정·자동 대사를 만들 필요는 없다.`;
