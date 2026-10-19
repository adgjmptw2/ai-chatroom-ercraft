// World editing is opt-in. The live shared home only offers resident actions.
export const CONSTRUCTION_ACTIONS = Object.freeze([
  'plan_request', 'build_plan', 'plan_pause', 'plan_cancel', 'build', 'block_define',
]);
export const constructionAllowed = cfg => cfg?.constructionEnabled === true;

export function availableWorldAction(action, cfg) {
  if (!action || typeof action !== 'object' || constructionAllowed(cfg)) return action;
  return Object.fromEntries(Object.entries(action).filter(([key]) => !CONSTRUCTION_ACTIONS.includes(key)));
}
