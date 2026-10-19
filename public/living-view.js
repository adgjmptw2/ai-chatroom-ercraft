import { appUrl } from './base-path.js';

const RECIPES = { soup: '수프', burger: '버거', tea: '차', toast: '토스트', dumplings: '만두', cookies: '쿠키', fruit: '과일' };
const RESIDENTS = { adina: '아디나', bianca: '비앙카', eleven: '일레븐', lucia: '루치아' };
const STYLES = { mint: ['민트', 0x82b9a4], butter: ['버터', 0xe8ca79], pink: ['핑크', 0xd99aac], lavender: ['라벤더', 0xaaa0cb] };
const SPOTS = Object.fromEntries([
  ...Array.from({ length: 4 }, (_, i) => [`sofa-${i + 1}`, `거실 소파 ${i + 1}번`]),
  ...Object.entries(RESIDENTS).map(([id, name]) => [`${id}-bed`, `${name} 침대`]),
]);
const EMPTY_PROPS = { revision: 0, tableSet: false, blankets: [] };
const validProps = p => p === undefined || p !== null && typeof p.tableSet === 'boolean'
  && Number.isSafeInteger(p.revision) && p.revision >= 0
  && Array.isArray(p.blankets) && p.blankets.length <= 4
  && p.blankets.every(b => b && typeof b.spot === 'string' && Object.hasOwn(SPOTS, b.spot)
    && typeof b.style === 'string' && Object.hasOwn(STYLES, b.style)
    && typeof b.owner === 'string' && Object.hasOwn(RESIDENTS, b.owner))
  && new Set(p.blankets.map(b => b.spot)).size === p.blankets.length;
const MEAL_STATUS = { cooking: '준비 중', ready: '준비 완료', served: '함께 먹는 중', finished: '식사 마침' };
const RESULTS = { draw: '무승부', abandoned: '게임 중단', expired: '시간 만료' };
const isState = s => s?.version === 1 && Number.isSafeInteger(s.revision) && s.revision >= 0
  && (s.pausedAt == null || Number.isFinite(s.pausedAt))
  && (s.meal === null || s.meal && typeof s.meal.recipe === 'string' && Object.hasOwn(RECIPES, s.meal.recipe)
    && Object.hasOwn(MEAL_STATUS, s.meal.status) && Array.isArray(s.meal.eatenBy)
    && s.meal.servings === 4 && Number.isInteger(s.meal.remaining) && s.meal.remaining >= 0 && s.meal.remaining <= 4)
  && (s.game === null || s.game?.kind === 'tic-tac-toe'
    && ['waiting', 'playing', 'finished'].includes(s.game.status)
    && Array.isArray(s.game.players) && s.game.players.length <= 2
    && Array.isArray(s.game.board) && s.game.board.length === 9 && s.game.board.every(c => c === null || c === 'X' || c === 'O')
    && Array.isArray(s.game.winningCells)) && Array.isArray(s.events) && validProps(s.props);

/** Read-only companion: public state in, DOM + twelve reusable meshes out.
 * setState is monotonic for SSE. reload is an authoritative GET/reset boundary;
 * an in-flight response cannot replace an SSE received after that GET began.
 * No clock, animation, controls, subscriptions or viewer mutation endpoints.
 */
export function createLivingView({ THREE, scene, root, invalidate = () => {}, memberName = id => id,
  fetchState = () => fetch(appUrl('/api/living'), { cache: 'no-store' }) }) {
  const doc = root?.ownerDocument;
  const group = new THREE.Group(); group.name = 'living-props'; scene.add(group);
  let state = null, disposed = false, streamSerial = 0, loadSerial = 0, anchorKey = '', inFlight = null;
  let members = new Map(), memberKey = '', unavailable = false, offline = false;
  let anchors = { board: null, dining: null, kitchen: null, blankets: {} };
  const geometries = new Set(), materials = new Set(), meshes = [];
  const geometry = g => { geometries.add(g); return g; };
  const material = color => { const m = new THREE.MeshLambertMaterial({ color }); materials.add(m); return m; };
  const box = geometry(new THREE.BoxGeometry(1, 1, 1));
  const disk = geometry(new THREE.CylinderGeometry(1, 1, 1, 16));
  const ring = geometry(new THREE.TorusGeometry(1, .12, 4, 16).rotateX(-Math.PI / 2));
  const round = geometry(new THREE.SphereGeometry(1, 10, 6));
  // A plump half-moon with a narrow crimped crest, shared by every dumpling.
  const dumpling = geometry(new THREE.SphereGeometry(1, 10, 6));
  const vertices = dumpling.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const y = vertices.getY(i);
    vertices.setXYZ(i, vertices.getX(i), (y + 1) * .5,
      vertices.getZ(i) * (y > 0 ? .28 : .72));
  }
  dumpling.computeVertexNormals();
  const ivory = material(0xfff1d4), ink = material(0x405968), teal = material(0x306b67), rose = material(0xb65366);
  const foodMaterial = material(0xffffff), metal = material(0x657b7b);
  const boardGroup = new THREE.Group(), diningGroup = new THREE.Group(), kitchenGroup = new THREE.Group();
  group.add(boardGroup, diningGroup, kitchenGroup);
  function mesh(parent, name, geo, mat, capacity = 1) {
    const m = new THREE.InstancedMesh(geo, mat, capacity);
    m.name = name; m.count = 0; m.visible = false;
    // Fixed batches; avoid stale bounding spheres as instances change.
    m.frustumCulled = false; parent.add(m); meshes.push(m); return m;
  }
  const board = mesh(boardGroup, 'living-board', box, ivory);
  const grid = mesh(boardGroup, 'living-grid', box, ink, 4);
  const crosses = mesh(boardGroup, 'living-X', box, teal, 18);
  const circles = mesh(boardGroup, 'living-O', ring, rose, 9);
  const plates = mesh(diningGroup, 'living-plates', disk, ivory, 4);
  const rims = mesh(diningGroup, 'living-rims', ring, ivory, 4);
  const food = mesh(diningGroup, 'living-food', disk, foodMaterial, 12);
  const foodDetails = mesh(diningGroup, 'living-food-details', box, foodMaterial, 80);
  const foodLayers = mesh(diningGroup, 'living-food-layers', disk, foodMaterial, 24);
  const pot = mesh(kitchenGroup, 'living-pot', disk, metal);
  const lid = mesh(kitchenGroup, 'living-lid', disk, ivory);
  const blankets = mesh(group, 'living-blankets', box, foodMaterial, 40);
  let foodServings = 0, foodInstanceCount = 0, cupCount = 0, blanketCount = 0;
  const transform = new THREE.Object3D(), tint = new THREE.Color();
  function place(m, index, x, y, z, sx, sy, sz, turn = 0, color) {
    transform.position.set(x, y, z); transform.scale.set(sx, sy, sz); transform.rotation.set(0, turn, 0);
    transform.updateMatrix(); m.setMatrixAt(index, transform.matrix);
    if (color !== undefined) m.setColorAt(index, tint.set(color));
  }
  function finish(m, count) {
    m.count = count; m.visible = count > 0; m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  place(board, 0, 0, 0, 0, .54, .028, .54); finish(board, 1);
  for (let i = 0; i < 2; i++) {
    const offset = (i - .5) * .18;
    place(grid, i, offset, .019, 0, .01, .009, .52);
    place(grid, i + 2, 0, .019, offset, .52, .009, .01);
  }
  finish(grid, 4);
  for (let i = 0; i < 4; i++) {
    const x = i < 2 ? -.92 : .92, z = i % 2 ? .52 : -.52;
    place(plates, i, x, .018, z, .21, .025, .21);
    place(rims, i, x, .04, z, .18, .25, .18);
  }
  finish(plates, 4); finish(rims, 4);
  place(pot, 0, 0, .12, 0, .23, .24, .23); finish(pot, 1);
  place(lid, 0, 0, .255, 0, .25, .03, .25); finish(lid, 1);

  const el = (tag, className, text) => {
    const node = doc.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text); return node;
  };
  let notice, mealBox, propBox, gameBox, eventBox;
  if (root) {
    notice = el('p', 'living-notice'); notice.setAttribute('role', 'status');
    mealBox = el('section', 'living-meal'); propBox = el('section', 'living-lifestyle');
    gameBox = el('section', 'living-game'); eventBox = el('section', 'living-events');
    root.replaceChildren(notice, mealBox, propBox, gameBox, eventBox);
  }
  const name = id => {
    if (!Object.hasOwn(RESIDENTS, id)) return '확인 중';
    const display = members.get(id) || memberName(id);
    return String(display && display !== id ? display : RESIDENTS[id]);
  };
  function renderNotice() {
    if (!notice) return;
    notice.textContent = unavailable ? `생활 상태 확인 불가${state ? ' · 마지막으로 받은 상태예요.' : ''}`
      : offline ? '연결 대기 중 · 마지막으로 받은 상태예요.'
      : !state ? '생활 상태 확인 중…'
      : state.pausedAt != null ? '집이 쉬는 중 · 생활 시계 일시 정지' : '멤버들의 생활을 관전하고 있어요.';
    root.dataset.connection = unavailable ? 'unknown' : offline ? 'offline' : state ? 'live' : 'loading';
  }
  function renderDOM() {
    if (!root) return;
    renderNotice(); mealBox.replaceChildren(el('h2', '', '주방 · 식사')); gameBox.replaceChildren(el('h2', '', '보드게임'));
    eventBox.replaceChildren(); root.dataset.revision = state ? String(state.revision) : '';
    const meal = state?.meal, game = state?.game;
    const props = state?.props || EMPTY_PROPS;
    propBox.replaceChildren(el('h2', '', '생활 소품'));
    propBox.append(el('p', 'living-table-status', !state ? '소품 상태 확인 전'
      : props.tableSet ? '식탁 · 상차림 완료'
      : ['served', 'finished'].includes(meal?.status) ? '식탁 · 식사 접시 놓임' : '식탁 · 상차림 전'));
    propBox.append(el('p', 'living-blanket-count', state ? `담요 ${props.blankets.length}/4개` : '담요 상태 확인 전'));
    if (props.blankets.length) {
      const list = el('ul', 'living-blanket-list');
      for (const b of props.blankets) list.append(el('li', '', `${SPOTS[b.spot]} · ${STYLES[b.style][0]} · ${name(b.owner)}`));
      propBox.append(list);
    }
    if (!meal) mealBox.append(el('p', 'living-muted', state ? '지금 준비된 식사가 없어요.' : '주방 상태 확인 전'));
    else {
      mealBox.append(el('p', 'living-meal-title', `${meal.label || RECIPES[meal.recipe]} · ${MEAL_STATUS[meal.status]}`),
        el('p', 'living-muted', `${name(meal.cook)}의 요리 · ${meal.servings}인분 중 ${meal.remaining}인분 남음`),
        el('p', 'living-eaters', `먹은 멤버: ${meal.eatenBy.length ? meal.eatenBy.map(name).join(', ') : '아직 없음'}`));
    }
    if (!game) gameBox.append(el('p', 'living-muted', state ? '진행 중인 게임이 없어요.' : '게임 상태 확인 전'));
    else {
      const players = game.players.map((id, i) => `${i ? 'O' : 'X'} ${name(id)}`).join(' · ');
      const status = game.status === 'waiting' ? '참가 멤버 기다리는 중'
        : game.status === 'playing' ? `${name(game.turn)} 차례`
        : game.result === 'win' ? `${name(game.winner)} 승리` : RESULTS[game.result] || '게임 종료';
      gameBox.append(el('p', 'living-players', players || '틱택토'), el('p', 'living-game-status', status));
      const table = el('table', 'living-board'); table.setAttribute('role', 'grid');
      table.setAttribute('aria-label', '틱택토 관전 보드'); table.setAttribute('aria-readonly', 'true');
      const body = el('tbody');
      for (let row = 0; row < 3; row++) {
        const tr = el('tr'); tr.setAttribute('role', 'row');
        for (let col = 0; col < 3; col++) {
          const i = row * 3 + col, mark = game.board[i], win = game.result === 'win' && game.winningCells.includes(i);
          const cell = el('td', `${mark ? `mark-${mark.toLowerCase()}` : ''}${win ? ' winning' : ''}`, mark || '·');
          cell.setAttribute('role', 'gridcell');
          cell.setAttribute('aria-label', `${row + 1}행 ${col + 1}열 ${mark || '빈칸'}${win ? ', 승리 칸' : ''}`); tr.append(cell);
        }
        body.append(tr);
      }
      table.append(body); gameBox.append(table);
    }
    if (state?.events.length) {
      eventBox.append(el('h2', '', '집 안 소식')); const list = el('ol');
      for (const event of state.events.slice(-8).reverse()) list.append(el('li', '', event.text));
      eventBox.append(list);
    }
  }
  function updateProps() {
    const game = state?.game, meal = state?.meal;
    boardGroup.visible = !!(anchors.board && game);
    diningGroup.visible = !!(anchors.dining && (state?.props?.tableSet || ['served', 'finished'].includes(meal?.status)));
    kitchenGroup.visible = !!(anchors.kitchen && ['cooking', 'ready'].includes(meal?.status));
    if (anchors.board) boardGroup.position.fromArray(anchors.board);
    if (anchors.dining) diningGroup.position.fromArray(anchors.dining);
    if (anchors.kitchen) kitchenGroup.position.fromArray(anchors.kitchen);
    let xCount = 0, oCount = 0;
    for (let i = 0; i < (game?.board.length || 0); i++) {
      const x = (i % 3 - 1) * .18, z = (Math.floor(i / 3) - 1) * .18;
      const color = game.result === 'win' && game.winningCells.includes(i) ? 0xffd17b : 0xffffff;
      if (game.board[i] === 'X') {
        for (const turn of [-Math.PI / 4, Math.PI / 4]) place(crosses, xCount++, x, .038, z, .13, .016, .025, turn, color);
      } else if (game.board[i] === 'O') place(circles, oCount++, x, .038, z, .05, .1, .05, 0, color);
    }
    finish(crosses, xCount); finish(circles, oCount);
    updateFood(meal); updateBlankets();
  }
  function updateFood(meal) {
    const recipe = meal?.recipe;
    food.geometry = recipe === 'toast' ? box : recipe === 'dumplings' ? dumpling
      : ['fruit', 'burger'].includes(recipe) ? round : disk;
    foodServings = meal?.status === 'served' ? meal.remaining : 0;
    let bodies = 0, details = 0, layers = 0;
    for (let i = 0; i < foodServings; i++) {
      const x = i < 2 ? -.92 : .92, z = i % 2 ? .52 : -.52;
      if (recipe === 'dumplings') {
        for (let j = 0; j < 3; j++) {
          const dx = x + (j - 1) * .07, dz = z + (j === 1 ? .075 : -.06), turn = (j - 1) * .3;
          place(food, bodies++, dx, .045, dz, .085, .10, .07, turn, 0xffe2aa);
          // Five alternating pleats cross the pinched seam, rather than a plain disk.
          for (let k = -2; k <= 2; k++) {
            const offset = k * .026;
            place(foodDetails, details++, dx + Math.cos(turn) * offset, .146 - Math.abs(k) * .01,
              dz - Math.sin(turn) * offset, .012, .015, .038, turn + (k % 2 ? .32 : -.32), 0xe4bd84);
          }
        }
      } else if (recipe === 'cookies') {
        for (let j = 0; j < 2; j++) {
          const dx = x + (j ? .07 : -.07), dz = z + (j ? .035 : -.035);
          place(food, bodies++, dx, .063, dz, .097, .035, .097, 0, 0xd89b54);
          for (const [cx, cz] of [[0, 0], [-.048, -.029], [.036, -.036], [-.025, .041], [.045, .03]]) {
            place(foodDetails, details++, dx + cx, .084, dz + cz, .025, .012, .023, .4 + j, 0x5b3829);
          }
        }
      } else if (recipe === 'fruit') {
        for (let j = 0; j < 3; j++) {
          const dx = x + (j - 1) * .09, dz = z + (j === 1 ? .07 : -.035), h = j === 2 ? .09 : .067;
          place(food, bodies++, dx, .044 + h, dz, .068, h, .065, 0, [0xcc564e, 0xf2a044, 0xa8bd65][j]);
          place(foodDetails, details++, dx, .05 + h * 2, dz, .012, .037, .012, 0, 0x69503b);
          place(foodDetails, details++, dx + .019, .065 + h * 2, dz, .044, .009, .023, .6, 0x507d54);
        }
      } else if (recipe === 'burger') {
        place(food, bodies++, x, .065, z, .145, .03, .145, 0, 0xd9984e);
        place(food, bodies++, x, .166, z, .145, .067, .145, 0, 0xe6ad61);
        for (const [y, h, radius, color] of [[.095, .027, .14, 0x674230], [.115, .012, .158, 0x749754], [.13, .016, .135, 0xcb6350]]) {
          place(foodLayers, layers++, x, y, z, radius, h, radius, 0, color);
        }
        place(foodDetails, details++, x, .109, z, .25, .01, .25, .2, 0xf6d67a);
        for (const [dx, dz] of [[0, 0], [-.065, 0], [.06, .025], [0, -.065], [-.025, .06]]) {
          place(foodDetails, details++, x + dx, .233 - (dx || dz ? .009 : 0), z + dz, .025, .008, .011, .4, 0xffe7b8);
        }
      } else {
        const toast = recipe === 'toast', height = toast ? .05 : .025, size = toast ? .24 : .15;
        place(food, bodies++, x, .04 + height / 2, z, size, height, size, 0,
          { soup: 0xe8ac45, tea: 0x896849, toast: 0xd89b54 }[recipe]);
      }
    }
    foodInstanceCount = bodies + details + layers;
    cupCount = diningGroup.visible ? 4 : 0;
    // Four empty cups share the food batches: eight cylinders and twelve handle
    // bars. Peak occupancy is 20/24 layers (burger) and 72/80 details (dumplings).
    // The shaded inner disk represents an empty recess, never an unserved drink.
    for (let i = 0; i < cupCount; i++) {
      const side = i < 2 ? 1 : -1, x = -side * .65, z = i % 2 ? .52 : -.52;
      place(foodLayers, layers++, x, .04, z, .065, .14, .065, 0, 0xfff1d4);
      place(foodLayers, layers++, x, .112, z, .051, .005, .051, 0, 0xb8aa90);
      for (const y of [.014, .081]) {
        place(foodDetails, details++, x + side * .084, y, z, .075, .015, .018, 0, 0xfff1d4);
      }
      place(foodDetails, details++, x + side * .114, .0475, z, .015, .08, .018, 0, 0xfff1d4);
    }
    finish(food, bodies); finish(foodDetails, details); finish(foodLayers, layers);
  }
  function updateBlankets() {
    let count = 0; blanketCount = 0;
    for (const b of state?.props?.blankets || []) {
      const at = anchors.blankets[b.spot]; if (!at) continue;
      blanketCount++;
      const [x, y, z] = at, color = STYLES[b.style][1], sofa = b.spot.startsWith('sofa-');
      // Match world-diorama's seat/duvet heights; the drop ends above the floor.
      if (sofa) {
        place(blankets, count++, x + .12, y + .83, z, .80, .036, .5, 0, color);
        place(blankets, count++, x + .50, y + .62, z, .04, .42, .5, 0, color);
        place(blankets, count++, x - .20, y + .855, z, .14, .025, .5, 0, color);
        for (let j = -2; j <= 2; j++) {
          place(blankets, count++, x + .526, y + .47, z + j * .085, .012, .05, .035, 0, 0xfff1d4);
        }
      } else {
        place(blankets, count++, x, y + .74, z + .23, 1.2, .035, .59, 0, color);
        place(blankets, count++, x, y + .52, z + .52, 1.2, .44, .04, 0, color);
        place(blankets, count++, x, y + .765, z - .005, 1.2, .025, .1, 0, color);
        for (let j = -2; j <= 2; j++) {
          place(blankets, count++, x + j * .21, y + .37, z + .546, .04, .055, .012, 0, 0xfff1d4);
        }
      }
    }
    finish(blankets, count);
  }
  function apply(next, reset = false) {
    if (disposed || !isState(next)) return false;
    if (state && (reset ? next.revision === state.revision && JSON.stringify(next) === JSON.stringify(state)
      : next.revision <= state.revision)) return false;
    state = structuredClone(next); unavailable = false; offline = false;
    renderDOM(); updateProps(); invalidate(); return true;
  }
  function setState(next) {
    if (disposed) return false;
    if (next?.unavailable === true) {
      // Preserve the last snapshot/props; a preceding GET cannot clear this newer warning.
      streamSerial++; unavailable = true; renderNotice(); return false;
    }
    if (!isState(next)) return false;
    // A reconnect may see the new lifetime's SSE before its reset GET returns.
    // Hold that lower revision until the GET confirms the reset; old replays alone
    // must neither roll back the view nor suppress a GET failure/reset.
    if (inFlight && state && next.revision < state.revision
      && (!inFlight.resetCandidate || next.revision > inFlight.resetCandidate.revision)) {
      inFlight.resetCandidate = structuredClone(next);
    }
    const changed = apply(next);
    if (changed) streamSerial++;
    if (state && next.revision >= state.revision && (unavailable || offline)) {
      unavailable = false; offline = false; renderNotice();
    }
    return changed;
  }
  async function reload() {
    const request = ++loadSerial, stream = streamSerial;
    const flight = { resetCandidate: null }; inFlight = flight;
    try {
      const response = await fetchState();
      if (!response.ok) throw new Error('Living state unavailable');
      const next = await response.json();
      if (!isState(next)) throw new Error('Invalid living state');
      if (disposed || request !== loadSerial || stream !== streamSerial) return false;
      const candidate = flight.resetCandidate;
      const resetState = state && next.revision < state.revision && candidate?.revision > next.revision ? candidate : next;
      const changed = apply(resetState, true);
      unavailable = false; offline = false; renderNotice(); return changed;
    } catch {
      if (!disposed && request === loadSerial && stream === streamSerial) { unavailable = true; renderNotice(); }
      return false;
    } finally {
      if (inFlight === flight) inFlight = null;
    }
  }
  function setMembers(list = []) {
    if (disposed) return;
    const entries = list.map(m => [m.id, m.name]), key = JSON.stringify(entries);
    if (key === memberKey) return;
    members = new Map(entries); memberKey = key; renderDOM();
  }
  function setHome(home, blocks) {
    if (disposed) return;
    const furniture = home?.id === 'mulgyeol-maru' ? home.furniture || {} : {};
    const exists = f => {
      if (!Array.isArray(f?.at) || f.at.length !== 3 || !f.at.every(Number.isFinite) || !f.shape) return false;
      const value = blocks instanceof Map ? blocks.get(f.at.join(',')) : blocks?.[f.at.join(',')];
      const [, shape, facing] = String(value || '').split('/');
      return shape === f.shape && (!facing || facing === f.facing);
    };
    const table = furniture['living-table'], dining = Object.entries(furniture).filter(([id]) => id.startsWith('dining-table-')).map(([, f]) => f);
    const counter = furniture['kitchen-south-31'];
    // The diorama replaces the continuous sofa if any of its four cells is lost.
    const sofaIntact = [1, 2, 3, 4].every(i => {
      const f = furniture[`sofa-${i}`]; return f?.shape === 'bench' && f.facing === 'e' && exists(f);
    });
    const blanketAnchors = {};
    for (const spot of Object.keys(SPOTS)) {
      const f = furniture[spot], sofa = spot.startsWith('sofa-');
      if (exists(f) && (sofa ? sofaIntact : f.shape === 'bed' && f.facing === 's')) {
        blanketAnchors[spot] = [f.at[0] + .5, f.at[1] - 1, f.at[2] + .5];
      }
    }
    const next = {
      // The board rests on the small book stack, clear of the rear plant.
      board: exists(table) ? [table.at[0] + .5, table.at[1] - .08, table.at[2] + .76] : null,
      dining: dining.length === 6 && dining.every(exists)
        ? [dining.reduce((sum, f) => sum + f.at[0] + .5, 0) / dining.length, 4.045,
          dining.reduce((sum, f) => sum + f.at[2] + .5, 0) / dining.length] : null,
      kitchen: exists(counter) ? [counter.at[0] + .88, counter.at[1] + .025, counter.at[2] + .27] : null,
      blankets: blanketAnchors,
    };
    const key = JSON.stringify(next); if (key === anchorKey) return;
    anchors = next; anchorKey = key; updateProps(); invalidate();
  }
  function setDisconnected() {
    if (disposed || offline) return; offline = true; renderNotice();
  }
  function stats() {
    return { revision: state?.revision ?? null, propsRevision: state?.props?.revision ?? 0, meshes: disposed ? 0 : meshes.length,
      visibleMeshes: disposed ? 0 : meshes.filter(m => m.visible && m.parent.visible).length,
      geometries: geometries.size, materials: materials.size, board: !disposed && boardGroup.visible,
      plates: !disposed && diningGroup.visible ? plates.count : 0, food: !disposed && diningGroup.visible ? foodServings : 0,
      cups: disposed ? 0 : cupCount, foodInstances: !disposed && diningGroup.visible ? foodInstanceCount : 0,
      blankets: disposed ? 0 : blanketCount, cooking: !disposed && kitchenGroup.visible };
  }
  function dispose() {
    if (disposed) return; disposed = true; loadSerial++;
    inFlight = null; scene.remove(group); for (const m of meshes) m.dispose();
    for (const g of geometries) g.dispose(); for (const m of materials) m.dispose();
    geometries.clear(); materials.clear(); group.clear(); root?.replaceChildren();
  }
  updateProps(); renderDOM();
  return { group, setState, reload, setMembers, setHome, setDisconnected, dispose, stats };
}
