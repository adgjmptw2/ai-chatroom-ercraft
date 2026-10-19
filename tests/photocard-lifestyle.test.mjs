import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHouse } from '../lib/house.mjs';
import { buildPhotocardPrompt, photocardLivingSnapshot, photocardWorldSnapshot } from '../lib/photocards.mjs';

// Pure in-memory fixtures. No room, adapter, image generation or service is used.
const names = { gpt: 'Adina', gemini: 'Bianca', claude: 'Eleven', deepseek: 'Lucia' };
const nameOf = id => names[id];
const house = buildHouse();
const fixture = () => ({
  state: { version: 1, revision: 99, meal: null, game: null, props: { revision: 3, tableSet: false, blankets: [] }, events: [] },
  options: { nameOf, home: structuredClone(house.home), avatars: {
    gpt: { x: 28, y: 4.46, z: 32, posture: 'sit', furniture: { shape: 'chair' } },
    gemini: { x: 18, y: 4.4, z: 11, posture: 'lie', furniture: { shape: 'bed' } },
    claude: { x: 10, y: 4.46, z: 32, posture: 'sit', furniture: { shape: 'bench' } },
    deepseek: { x: 31, y: 4, z: 35, posture: 'work', furniture: { shape: 'workbench' } },
  } },
});
const meal = (recipe = 'dumplings', status = 'served') => ({
  id: 'PRIVATE_MEAL_ID', revision: 7, recipe, label: 'PRIVATE_LABEL', status, cook: 'deepseek', readyAt: 99999,
  servings: 4, remaining: status === 'finished' ? 0 : status === 'served' ? 3 : 4,
  eatenBy: status === 'finished' ? Object.keys(names) : status === 'served' ? ['claude'] : [],
});
const game = (status = 'playing') => ({
  id: 'PRIVATE_GAME_ID', revision: 3, kind: 'tic-tac-toe', status,
  players: status === 'waiting' ? ['claude'] : ['claude', 'gpt'],
  board: status === 'finished' ? ['X', 'X', 'X', 'O', 'O', null, null, null, null]
    : status === 'waiting' ? Array(9).fill(null) : ['X', null, null, null, null, null, null, null, null],
  turn: status === 'playing' ? 'gpt' : null, winner: status === 'finished' ? 'claude' : null,
  result: status === 'finished' ? 'win' : null, winningCells: [0, 1, 2], expiresAt: 100000,
});

test('live block verification omits removed furniture even when home metadata remains', () => {
  const {state,options}=fixture();
  state.props.tableSet=true; state.meal=meal();
  state.props.blankets=[{spot:'sofa-1',style:'mint',owner:'gpt'}];
  options.blocks=new Map(Object.entries(house.blocks));
  assert.ok(photocardLivingSnapshot(state,options).meal.location);
  options.blocks.delete('25,4,32'); options.blocks.delete('10,4,32');
  const snapshot=photocardLivingSnapshot(state,options);
  assert.equal(snapshot.meal.location,null); assert.equal(snapshot.props.table,null);
  assert.equal(snapshot.props.blankets[0].location,null);
});

test('all seven recipes retain their actual cooking, ready, served and finished states', () => {
  const { state, options } = fixture();
  for (const recipe of ['soup', 'burger', 'tea', 'toast', 'dumplings', 'cookies', 'fruit']) {
    for (const status of ['cooking', 'ready', 'served', 'finished']) {
      state.meal = meal(recipe, status);
      const projected = photocardLivingSnapshot(state, options).meal;
      assert.equal(projected.recipe, recipe);
      assert.equal(projected.status, status);
      assert.equal(projected.cook, 'Lucia');
      assert.equal(projected.remaining, state.meal.remaining);
      assert.deepEqual(projected.eatenBy, state.meal.eatenBy.map(nameOf));
      const cooking = status === 'cooking' || status === 'ready';
      assert.deepEqual(projected.location, cooking
        ? { name: options.home.furniture['kitchen-south-31'].name, position: [31, 4, 36] }
        : { name: options.home.furniture['dining-table-25-32'].name, position: [26, 4, 32.5] });
      assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|revision|readyAt|deepseek|claude|gemini|gpt/);
    }
  }
});

test('explicitly absent food differs from missing, unavailable or malformed food; none invents a recipe', () => {
  const { state, options } = fixture();
  assert.equal(photocardLivingSnapshot(state, options).meal, null);
  for (const source of [undefined, null, { unavailable: true }, { version: 2, meal: meal() }, { version: 1 },
    { version: 1, meal: {} }, { version: 1, meal: { ...meal(), recipe: 'PRIVATE_RECIPE' } },
    { version: 1, meal: { ...meal(), status: 'snack_share' } },
    { version: 1, meal: { ...meal(), remaining: 5 } },
    { version: 1, meal: { ...meal(), status: 'finished', remaining: 3 } },
    { version: 1, meal: { ...meal(), eatenBy: ['UNKNOWN_ID'] } },
    { version: 1, meal: { ...meal(), remaining: 2, eatenBy: ['claude', 'claude'] } },
    { version: 1, meal: { ...meal(), remaining: 0, eatenBy: Array(500).fill('gpt') } }]) {
    const projected = photocardLivingSnapshot(source, options);
    assert.deepEqual(projected.meal, { status: 'unknown' });
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|UNKNOWN_ID|recipe|snack_share/);
  }
});

test('selection records presence and pose only; it does not invent eaters, companions or players', () => {
  const { state, options } = fixture();
  state.meal = meal(); state.game = game();
  options.subjects = [{ id: 'gpt', name: 'PRIVATE_NAME' }, { id: 'gemini', name: 'PRIVATE_NAME' }];
  const projected = photocardLivingSnapshot(state, options);
  assert.deepEqual(projected.presentSubjects.map(member => member.name), ['Adina', 'Bianca']);
  assert.deepEqual(projected.presentSubjects.map(member => member.posture), ['sit', 'lie']);
  assert.deepEqual(projected.presentSubjects.map(member => member.position), [[28, 4.46, 32], [18, 4.4, 11]]);
  assert.deepEqual(projected.meal.eatenBy, ['Eleven']);
  assert.deepEqual(projected.game.players, ['Eleven', 'Adina']);
  delete options.avatars.gemini;
  assert.deepEqual(photocardLivingSnapshot(state, options).presentSubjects.map(member => member.name), ['Adina']);
  options.avatars.gpt.x = -1;
  assert.deepEqual(photocardLivingSnapshot(state, options).presentSubjects, []);
});

test('board status, marks, turn and winner are projected as public names at the living table', () => {
  const { state, options } = fixture();
  for (const status of ['waiting', 'playing', 'finished']) {
    state.game = game(status);
    const projected = photocardLivingSnapshot(state, options).game;
    assert.equal(projected.status, status);
    assert.deepEqual(projected.players, state.game.players.map(nameOf));
    assert.deepEqual(projected.board, state.game.board);
    assert.equal(projected.turn, state.game.turn ? nameOf(state.game.turn) : null);
    assert.equal(projected.winner, status === 'finished' ? 'Eleven' : null);
    assert.deepEqual(projected.location, { name: options.home.furniture['living-table'].name, position: [15, 4, 33] });
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|revision|expiresAt|winningCells|claude|gpt/);
  }
  for (const change of [{ board: ['PRIVATE'] }, { players: ['UNKNOWN'] }, { turn: 'deepseek' },
    { status: 'PRIVATE' }, { status: 'waiting' }, { status: 'finished', turn: null }, { turn: null },
    { players: Array(20).fill('gpt') }, { board: Array(9000).fill(null) }]) {
    state.game = { ...game(), ...change };
    assert.deepEqual(photocardLivingSnapshot(state, options).game, { status: 'unknown' });
  }
});

test('table settings and all allowed blankets use exact home names/positions and public owners', () => {
  const { state, options } = fixture();
  state.props.tableSet = true;
  const spots = ['sofa-1', 'sofa-2', 'sofa-3', 'sofa-4', 'adina-bed', 'bianca-bed', 'eleven-bed', 'lucia-bed'];
  for (const [index, spot] of spots.entries()) {
    const style = ['mint', 'butter', 'pink', 'lavender'][index % 4];
    state.props.blankets = [{ spot, style, owner: 'gemini' }];
    const projected = photocardLivingSnapshot(state, options).props;
    assert.equal(projected.tableSet, true);
    assert.deepEqual(projected.table, { name: options.home.furniture['dining-table-25-32'].name, position: [26, 4, 32.5] });
    assert.deepEqual(projected.blankets, [{ style, owner: 'Bianca', location: {
      name: options.home.furniture[spot].name, position: options.home.furniture[spot].at,
    } }]);
    assert.doesNotMatch(JSON.stringify(projected), /gemini|revision|"spot"/);
  }
});

test('missing or malformed anchors remain unknown with no substitute furniture', () => {
  const { state, options } = fixture();
  state.meal = meal(); state.game = game(); state.props.tableSet = true;
  state.props.blankets = [{ spot: 'adina-bed', style: 'mint', owner: 'gemini' }];
  delete options.home.furniture['dining-table-25-32'];
  options.home.furniture['adina-bed'].at = [500, 4, 11];
  options.home.furniture['living-table'].shape = 'chair';
  let projected = photocardLivingSnapshot(state, options);
  assert.equal(projected.props.table, null);
  assert.equal(projected.meal.location, null);
  assert.equal(projected.game.location, null);
  assert.equal(projected.props.blankets[0].location, null);
  state.meal = meal('cookies', 'ready');
  options.home.furniture['kitchen-south-31'].at = [31, 4];
  assert.equal(photocardLivingSnapshot(state, options).meal.location, null);
  options.home = { id: 'other-home', furniture: house.home.furniture };
  projected = photocardLivingSnapshot(state, options);
  assert.equal(projected.meal.location, null);
  assert.equal(projected.props.blankets[0].location, null);
});

test('missing props stay unknown; invalid spots, colors, owners, duplicates or oversize lists are not rendered', () => {
  const { state, options } = fixture();
  delete state.props;
  assert.deepEqual(photocardLivingSnapshot(state, options).props, { tableSet: null, table: null, blankets: null });
  const blanket = { spot: 'sofa-1', style: 'butter', owner: 'gpt' };
  for (const blankets of [[{ ...blanket, spot: 'PRIVATE_ID' }], [{ ...blanket, style: 'PRIVATE_STYLE' }],
    [{ ...blanket, owner: 'PRIVATE_OWNER' }], [blanket, blanket], Array(500).fill(blanket), 'PRIVATE',
    ['sofa-1', 'sofa-2', 'sofa-3', 'sofa-4', 'adina-bed'].map(spot => ({ ...blanket, spot }))]) {
    state.props = { tableSet: 'true', blankets };
    const projected = photocardLivingSnapshot(state, options).props;
    assert.equal(projected.tableSet, null);
    assert.equal(projected.blankets, null);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  }
  state.props = { tableSet: false, blankets: [] };
  assert.deepEqual(photocardLivingSnapshot(state, options).props, { tableSet: false, table: null, blankets: [] });
});

test('snapshots ignore logs, scope revisions and arbitrary fields, and remain detached after state changes', () => {
  const { state, options } = fixture();
  state.meal = meal(); state.game = game(); state.events = Array(100).fill({ text: 'PRIVATE_EVENT', id: 'PRIVATE_EVENT_ID' });
  state.log = 'PRIVATE_LOG'; state.props.tableSet = true;
  state.props.blankets = [{ spot: 'sofa-2', style: 'lavender', owner: 'deepseek', private: 'PRIVATE_BLANKET' }];
  options.avatars.unknown = { x: 1, y: 1, z: 1, name: 'PRIVATE_AVATAR' };
  options.home.furniture['sofa-2'].private = 'PRIVATE_ANCHOR';
  const before = structuredClone({ state, avatars: options.avatars, home: options.home });
  const projected = photocardLivingSnapshot(state, options);
  assert.deepEqual({ state, avatars: options.avatars, home: options.home }, before);
  const captured = JSON.stringify(projected);
  assert.doesNotMatch(captured, /PRIVATE|gpt|claude|gemini|deepseek|revision|readyAt|expiresAt/);
  assert.ok(captured.length < 2400);
  state.meal.eatenBy.push('gpt'); state.meal.recipe = 'soup'; state.game.board[0] = null;
  state.props.blankets[0].style = 'pink'; options.home.furniture['sofa-2'].at[0] = 0; options.avatars.gpt.x = 0;
  assert.equal(JSON.stringify(projected), captured);
  assert.equal(photocardLivingSnapshot(before.state).presentSubjects.length, 0);
  assert.equal(photocardLivingSnapshot(before.state).meal.cook, 'Lucia');
});

test('snapshot authority overrides food and gathering claims while preserving identity, wardrobe and poses', () => {
  const { state, options } = fixture();
  state.meal = meal('cookies'); state.game = game();
  state.props.blankets = [{ spot: 'sofa-1', style: 'pink', owner: 'gemini' }];
  const subjects = ['gpt', 'gemini'].map(id => ({ id, name: nameOf(id) }));
  const livingSnapshot = photocardLivingSnapshot(state, { ...options, subjects });
  const prompt = buildPhotocardPrompt({ photocard: true, subjects, prompt: 'Everyone together finished soup under one blanket',
    livingSnapshot, worldSnapshot: photocardWorldSnapshot(subjects, options.avatars, 100) });
  assert.ok(prompt.includes(JSON.stringify(livingSnapshot)));
  for (const text of ['Snapshots override scene/context', 'exact recipe', 'Only eatenBy records who ate',
    'not proof they are still together', 'ownership does not put a blanket on its owner', 'never add unselected people',
    'Keep standing people standing', 'Never gather distant people', 'Adina identity', 'Bianca identity',
    'If no relevant outfit or occasion is supplied, retain the reference outfit', 'never recolor hair or swap identities']) {
    assert.ok(prompt.includes(text), text);
  }
  assert.doesNotMatch(prompt, /PRIVATE|CCTV|rounded pastel frame/);
});
