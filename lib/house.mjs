/**
 * Approved 2026-10-01 Mulgyeol Maru source fixture. Pure and deterministic:
 * importing/calling this module never reads, writes, or resets a running world.
 *
 * buildHouse() returns World's saved JSON object (NOT World.view() cells):
 * {blocks: {'x,y,z': material[/shape/facing]}, avatars, custom, signs, log, home}.
 * home is public, versioned presentation metadata; member IDs occur only in
 * avatars and the separately exported ROOM_ASSIGNMENTS integration map.
 * All rectXZ and y ranges are end-exclusive. floorY is physical feet height;
 * furniture anchors and standing avatar y are floorY + 1. Cutaway groups are
 * render-only selectors, never instructions to remove world geometry.
 * The integrating World must preserve home in load/save/view/applyCells; older
 * World implementations load the geometry but discard unknown home metadata.
 * Installation is an explicit, backed-up, stopped-server operation by the host.
 */
export const HOUSE_VERSION = '2026-10-01.1';
export const ROOM_ASSIGNMENTS = Object.freeze({
  gpt: 'adina', gemini: 'bianca', claude: 'eleven', deepseek: 'lucia',
});

const RESIDENTS = [
  ['adina', '아디나', 10, 'casa_sage', 'casa_star'],
  ['bianca', '비앙카', 17, 'casa_butter', 'casa_check'],
  ['eleven', '일레븐', 24, 'casa_rose', 'casa_cards'],
  ['lucia', '루치아', 31, 'casa_lavender', 'casa_tea'],
];
const FRONT = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
const AUTHOR = '물결마루';
const CREATED_AT = Date.UTC(2026, 9, 1);
const COMMON_SPAWNS = { adina: [13, 31], bianca: [26, 35], eleven: [18, 34], lucia: [32, 33] };

export function buildHouse() {
  const blocks = {}, custom = {}, signs = {}, furniture = {}, avatars = {};
  const put = (x, y, z, material) => { blocks[`${x},${y},${z}`] = material; };
  const fill = ([x0, z0, x1, z1], y0, y1, material) => {
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++)
      for (let y = y0; y < y1; y++) put(x, y, z, material);
  };
  const erase = (rect, y0, y1) => {
    const [x0, z0, x1, z1] = rect;
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++)
      for (let y = y0; y < y1; y++) delete blocks[`${x},${y},${z}`];
  };
  const tile = (name, colors, pixels) => {
    custom[name] = { colors, pixels, clear: false, glow: false, by: AUTHOR, at: CREATED_AT };
  };
  const mineral = ['aaaaaaaa', 'aabaaaaa', 'aaaaaaab', 'aaaaaaaa', 'baaaaaaa', 'aaaabaaa', 'aaaaaaaa', 'aaaaabaa'];
  for (const [name, base, fleck] of [
    ['casa_cream', '#f1e5cc', '#e3d4b7'], ['casa_frame', '#658783', '#50716d'],
    ['casa_doorframe', '#718591', '#5c707b'], ['casa_paving', '#bbb3a2', '#aaa28f'],
    ['casa_sage', '#a4b59a', '#8a9f80'], ['casa_butter', '#ead58d', '#d5bd78'],
    ['casa_rose', '#dca6b1', '#c68e9b'], ['casa_lavender', '#a3a0bd', '#797f9e'],
    ['casa_pot', '#b98064', '#a76f54'],
  ]) tile(name, { a: base, b: fleck }, [...mineral]);
  tile('casa_oak', { a: '#caa16b', b: '#b38a55', c: '#dcc08a' },
    ['bbbbbbbb', 'aaaaacaa', 'acaaaaaa', 'aaaabaaa', 'bbbbbbbb', 'aaaacaaa', 'aaacaaaa', 'abaaaaaa']);
  tile('casa_roof', { a: '#668e82', b: '#476f66', c: '#7ca092' },
    ['bbbbbbbb', 'acaaacaa', 'aaaabaaa', 'aaaabaaa', 'bbbbbbbb', 'aaacaaac', 'baaaaaaa', 'baaaaaaa']);
  tile('casa_tile', { a: '#eee7d9', b: '#b6cebf' },
    ['bbbbbbbb', 'baaaaaaa', 'baaaaaaa', 'baaaaaaa', 'bbbbbbbb', 'baaaaaaa', 'baaaaaaa', 'baaaaaaa']);
  tile('casa_star', { a: '#374d64', b: '#e5c98c', c: '#869aaa' },
    ['aaaaaaaa', 'aabaaaaa', 'aabaccaa', 'bbbbacaa', 'aabacaaa', 'aacaaaba', 'aaacccaa', 'aaaaaaaa']);
  tile('casa_check', { a: '#ead58d', b: '#f6e9bb', c: '#785060' },
    ['aabbaabb', 'aabbaabb', 'bbaabbaa', 'bbaabbaa', 'aabbaabb', 'aabbccbb', 'bbaaccca', 'bbaaccca']);
  tile('casa_cards', { a: '#bd9573', b: '#f4e7cf', c: '#d68d9d' },
    ['aaaaaaaa', 'abbbabba', 'acbbabba', 'abbbaaca', 'aaaaabba', 'abbbabba', 'abcbaaaa', 'aaaaaaaa']);
  tile('casa_tea', { a: '#686e8a', b: '#d4d9d8', c: '#a8a0bf' },
    ['aaaaaaaa', 'aacaccaa', 'aaacaaaa', 'aabbbbaa', 'aabbbbba', 'aaabbbba', 'abbbbbba', 'aaaaaaaa']);
  tile('casa_album', { a: '#dcc8a3', b: '#f2eadb', c: '#83aaa0', d: '#bdcfa8' },
    ['aaaaaaaa', 'abbbbbba', 'abccccba', 'abccccba', 'abcddcba', 'abddddba', 'abbbbbba', 'aaaaaaaa']);
  tile('casa_console', { a: '#526977', b: '#a7c9bd', c: '#ead58d' },
    ['aaaaaaaa', 'abbbbbba', 'ababbaba', 'abbbbbba', 'aaaaaaaa', 'aacacaaa', 'aaaaaaaa', 'aaaaaaaa']);

  const rooms = RESIDENTS.map(([id, name, x]) => ({
    id, name, kind: 'bedroom', rectXZ: [x, 10, x + 6, 16],
    entrances: [{ name: `${name} 방문`, rectXZ: [x + 2, 16, x + 4, 17], y: [4, 7] }],
  }));
  rooms.push(
    { id: 'north-maru', name: '북쪽 툇마루', kind: 'gallery', rectXZ: [10, 17, 37, 20] },
    { id: 'west-maru', name: '서쪽 툇마루', kind: 'gallery', rectXZ: [15, 20, 18, 26] },
    { id: 'courtyard', name: '중정', kind: 'courtyard', rectXZ: [18, 20, 29, 26] },
    { id: 'east-maru', name: '동쪽 툇마루', kind: 'gallery', rectXZ: [29, 20, 32, 26] },
    { id: 'south-maru', name: '남쪽 툇마루', kind: 'gallery', rectXZ: [10, 26, 37, 29] },
    { id: 'bath', name: '욕실·세탁', kind: 'bath', rectXZ: [10, 21, 14, 25],
      entrances: [{ name: '욕실', rectXZ: [14, 22, 15, 24], y: [4, 7] }] },
    { id: 'album', name: '사진·앨범 코너', kind: 'album', rectXZ: [32, 20, 37, 26],
      entrances: [{ name: '앨범 코너', rectXZ: [32, 20, 33, 26], y: [4, 7] }] },
    { id: 'common', name: '공용 거실·식당·주방', kind: 'common', rectXZ: [10, 30, 37, 37],
      entrances: [
        { name: '거실-마루', rectXZ: [12, 29, 17, 30], y: [4, 7] },
        { name: '중앙-마루', rectXZ: [20, 29, 26, 30], y: [4, 7] },
      ] },
  );
  const entrances = [
    { id: 'front', name: '현관', rectXZ: [20, 37, 23, 38], y: [4, 7],
      // These are adjacent physical surfaces, ground first, then three steps.
      stairRoute: [[21, 0, 41], [21, 1, 40], [21, 2, 39], [21, 3, 38], [21, 3, 37]], width: 3 },
    { id: 'garden', name: '서쪽 정원문', rectXZ: [9, 26, 10, 29], y: [4, 7],
      stairRoute: [[5, 0, 27], [6, 1, 27], [7, 2, 27], [8, 3, 27], [9, 3, 27]], width: 3 },
  ];

  // A solid raised plinth prevents hidden ground-level routes beneath the house.
  fill([9, 9, 38, 38], 1, 3, 'casa_paving');
  fill([9, 9, 38, 38], 3, 4, 'casa_oak');
  fill([18, 20, 29, 26], 3, 4, 'casa_paving');
  fill([10, 21, 14, 25], 3, 4, 'casa_tile');
  // Sea and a modest sandy shoreline, safely outside every entrance route.
  fill([41, 8, 48, 48], 1, 2, 'water');
  fill([8, 44, 41, 48], 1, 2, 'water');
  fill([39, 8, 41, 44], 1, 2, 'sand/slab');
  fill([8, 42, 39, 44], 1, 2, 'sand/slab');

  const wall = (rect) => fill(rect, 4, 8, 'casa_cream');
  for (const rect of [[9, 9, 38, 10], [9, 37, 38, 38], [9, 10, 10, 37], [37, 10, 38, 37],
    [10, 16, 37, 17], [10, 29, 37, 30], [10, 20, 15, 21], [14, 21, 15, 25], [10, 25, 15, 26]]) wall(rect);
  for (const x of [16, 23, 30]) wall([x, 10, x + 1, 16]);

  const open = (opening, door = false) => {
    erase(opening.rectXZ, ...opening.y);
    fill(opening.rectXZ, 7, 8, 'casa_doorframe');
    if (door) fill(opening.rectXZ, 4, 7, opening.rectXZ[2] - opening.rectXZ[0] === 1 ? 'door/z' : 'door/x');
  };
  for (const room of rooms) for (const opening of room.entrances || []) {
    if (room.id !== 'album') open(opening, ['bedroom', 'bath'].includes(room.kind));
  }
  for (const entrance of entrances) open(entrance);
  for (let step = 1; step <= 3; step++) {
    fill([20, 41 - step, 23, 42 - step], 1, step, 'casa_paving');
    fill([20, 41 - step, 23, 42 - step], step, step + 1, 'casa_paving/stair/n');
    fill([5 + step, 26, 6 + step, 29], 1, step, 'casa_paving');
    fill([5 + step, 26, 6 + step, 29], step, step + 1, 'casa_paving/stair/e');
  }

  const window = (rect) => {
    fill(rect, 4, 5, 'casa_frame'); fill(rect, 5, 7, 'glass'); fill(rect, 7, 8, 'casa_frame');
  };
  for (const [, , x, accent, art] of RESIDENTS) {
    window([x + 2, 9, x + 5, 10]);
    fill([x + 5, 9, x + 6, 10], 5, 7, accent);
    put(x + 1, 6, 9, art);
  }
  for (const rect of [[11, 37, 17, 38], [25, 37, 29, 38], [32, 37, 36, 38],
    [9, 31, 10, 35], [37, 31, 38, 35], [9, 22, 10, 24]]) window(rect);
  // Open gallery arches give the courtyard air without obstructing its loop.
  erase([9, 17, 10, 20], 4, 7); erase([37, 17, 38, 20], 4, 7);
  erase([37, 26, 38, 29], 4, 7);
  for (const [x, z] of [[18, 20], [28, 20], [18, 25], [28, 25]]) fill([x, z, x + 1, z + 1], 4, 8, 'casa_oak');
  fill([18, 20, 29, 21], 7, 8, 'casa_oak'); fill([18, 25, 29, 26], 7, 8, 'casa_oak');

  const roofGroups = [], wallGroups = [];
  const roof = (id, rectXZ, flat = false) => {
    roofGroups.push({ id, kind: 'roof', rectXZ, y: [8, 10] });
    const [x0, z0, x1, z1] = rectXZ;
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
      if (flat) put(x, 8, z, 'casa_roof/slab');
      else {
        // Timber ceiling/rafters and shallow stepped, weathered tile roof.
        put(x, 8, z, 'casa_oak/slab');
        const edge = x === x0 || x === x1 - 1 || z === z0 || z === z1 - 1;
        if (edge) put(x, 8, z, `casa_roof/stair/${z === z0 ? 's' : z === z1 - 1 ? 'n' : x === x0 ? 'e' : 'w'}`);
        else put(x, 9, z, 'casa_roof/slab');
      }
    }
  };
  roof('bedroom-roof', [9, 9, 38, 17]);
  roof('north-gallery-roof', [9, 17, 38, 20], true);
  roof('bath-roof', [9, 20, 15, 26]);
  roof('west-gallery-roof', [15, 20, 18, 26], true);
  roof('album-roof', [32, 20, 38, 26]);
  roof('east-gallery-roof', [29, 20, 32, 26], true);
  roof('south-gallery-roof', [9, 26, 38, 29], true);
  roof('common-roof', [9, 29, 38, 38]);
  for (const [id, rectXZ] of [
    ['south-wall', [9, 37, 38, 38]], ['east-common-wall', [37, 30, 38, 37]],
    ['common-gallery-wall', [10, 29, 37, 30]], ['album-east-wall', [37, 20, 38, 26]],
  ]) wallGroups.push({ id, kind: 'wall', rectXZ, y: [4, 8] });

  const furnish = (id, name, roomId, at, shape, facing, material = 'casa_oak') => {
    put(...at, `${material}/${shape}/${facing}`);
    const [dx, dz] = FRONT[facing];
    furniture[id] = { name, roomId, at, shape, facing, approach: [at[0] + dx, 4, at[2] + dz] };
  };
  const sign = (at, text, facing = 's', width = 3) => {
    signs[at.join(',')] = { text, facing, width, bg: '#526f6b', color: '#fff2d7', glow: false, by: AUTHOR };
  };
  const spawnPositions = {};
  for (const [id, name, x, accent] of RESIDENTS) {
    fill([x, 10, x + 2, 13], 3, 4, accent);
    // The actual bed stays ONE usable cell. The concept footprint is a floor
    // textile, never a solid mattress extension that intersects a lying body.
    furnish(`${id}-bed`, `${name} 침대`, id, [x + 1, 4, 11], 'bed', 's', accent);
    furnish(`${id}-desk`, `${name} 책상`, id, [x + 4, 4, 10], 'workbench', 's');
    furnish(`${id}-chair`, `${name} 의자`, id, [x + 4, 4, 13], 'chair', 'n', accent);
    const [sx, sz] = COMMON_SPAWNS[id];
    spawnPositions[id] = { name, x: sx, y: 4, z: sz, posture: 'stand', facing: 's' };
    sign([x + 2, 7, 16], name, 's', 2);
  }
  for (const [memberId, roomId] of Object.entries(ROOM_ASSIGNMENTS)) {
    const { name, ...spawn } = spawnPositions[roomId];
    avatars[memberId] = spawn;
  }
  // Brass reading light, checked throw, cards, and a small silver tea tray.
  put(10, 4, 10, 'casa_oak'); put(10, 5, 10, 'lamp');
  put(17, 3, 12, 'casa_check'); put(22, 4, 10, 'casa_lavender/slab');
  put(29, 5, 9, 'casa_cards'); put(36, 4, 10, 'casa_tea/slab');

  fill([12, 31, 18, 36], 3, 4, 'casa_sage');
  for (let z = 32; z < 36; z++) furnish(`sofa-${z - 31}`, '거실 소파', 'common', [10, 4, z], 'bench', 'e', 'casa_sage');
  furnish('living-table', '거실 탁자', 'common', [15, 4, 33], 'table', 'e');
  for (let x = 25; x < 28; x++) for (let z = 32; z < 34; z++)
    furnish(`dining-table-${x}-${z}`, '함께 먹는 식탁', 'common', [x, 4, z], 'table', z === 32 ? 'n' : 's');
  for (const [x, z, facing] of [[24, 32, 'e'], [24, 33, 'e'], [28, 32, 'w'], [28, 33, 'w']])
    furnish(`dining-chair-${x}-${z}`, '식탁 의자', 'common', [x, 4, z], 'chair', facing, 'casa_butter');
  for (let x = 31; x < 37; x++) {
    if (x % 2) furnish(`kitchen-south-${x}`, '주방 조리대', 'common', [x, 4, 36], 'workbench', 'n', 'casa_tile');
    else put(x, 4, 36, 'casa_cream');
  }
  for (let z = 31; z < 36; z++) {
    if (z % 2) furnish(`kitchen-east-${z}`, z === 33 ? '설거지 자리' : '주방 작업대', 'common', [36, 4, z], 'workbench', 'w', 'casa_tile');
    else put(36, 4, z, 'casa_cream');
  }
  put(36, 6, 36, 'casa_frame'); // chimney hood stays above all working poses
  furnish('laundry', '세탁 작업대', 'bath', [10, 4, 24], 'workbench', 'e', 'casa_tile');
  furnish('bath-stool', '욕실 의자', 'bath', [12, 4, 21], 'chair', 's', 'casa_frame');
  put(10, 4, 21, 'casa_tile/slab'); put(10, 5, 20, 'glass');

  for (let x = 24; x < 28; x++) furnish(`courtyard-bench-${x}`, '동백 옆 벤치', 'courtyard', [x, 4, 21], 'bench', 's');
  fill([18, 20, 20, 22], 3, 4, 'casa_sage');
  put(19, 4, 21, 'casa_pot'); put(19, 5, 21, 'leaves');
  put(18, 5, 21, 'leaves'); put(19, 5, 20, 'leaves'); put(19, 6, 21, 'casa_rose/slab');
  for (let z = 21; z < 25; z++) put(36, 4, z, 'bookshelf');
  for (const x of [33, 34]) furnish(`album-table-${x}`, '앨범 탁자', 'album', [x, 4, 22], 'table', 's');
  for (let x = 33; x < 36; x++) furnish(`album-bench-${x}`, '추억을 보는 자리', 'album', [x, 4, 24], 'bench', 'n', 'casa_lavender');
  furnish('maintenance-console', '나쟈의 작은 콘솔', 'album', [36, 4, 25], 'workbench', 'w');
  put(36, 5, 25, 'casa_console');
  const displaySlots = [];
  for (const y of [5, 6]) for (const z of [21, 22, 23]) {
    put(37, y, z, 'casa_album'); displaySlots.push({ at: [37, y, z], facing: 'w' });
  }
  // Four warm fixtures total; custom textures never allocate extra lights.
  for (const at of [[12, 7, 33], [28, 7, 35], [35, 7, 23]]) put(...at, 'lamp');
  sign([23, 6, 37], '물결마루', 's', 4);
  sign([10, 6, 16], '북쪽 툇마루', 's', 3);
  sign([14, 7, 22], '욕실·세탁', 'e', 3);
  sign([37, 7, 24], '사진과 추억', 'w', 3);
  sign([36, 6, 25], '나쟈의 작은 콘솔', 'w', 3);
  sign([31, 6, 37], '오늘의 식탁', 'n', 3);
  sign([28, 6, 20], '동백 중정', 's', 3);

  // A dining chair faces the table, but is entered from an open side. Publish
  // actual transfer/working cells so navigation need not aim inside a blocker.
  for (const f of Object.values(furniture)) {
    if (f.shape === 'table' || f.shape === 'workbench') continue;
    const candidates = [FRONT[f.facing], ...Object.values(FRONT)];
    const [dx, dz] = candidates.find(([dx, dz]) => {
      const x = f.at[0] + dx, z = f.at[2] + dz;
      return blocks[`${x},3,${z}`] && !blocks[`${x},4,${z}`] && !blocks[`${x},5,${z}`];
    }) || [];
    if (dx === undefined) throw new Error(`No clear furniture approach: ${f.name}`);
    f.approach = [f.at[0] + dx, 4, f.at[2] + dz];
  }

  const home = {
    id: 'mulgyeol-maru', title: AUTHOR, version: 1, schemaVersion: 1, fixtureVersion: HOUSE_VERSION,
    floorY: 3, roofY: 8, wallTopY: 7, roofTopY: 9, bounds: [9, 9, 38, 38], rectXZ: [9, 9, 38, 38],
    rangeConvention: '[start,end)', rooms, entrances, spawns: spawnPositions, furniture,
    commonRoomZones: [
      { id: 'living', name: '거실', rectXZ: [10, 30, 20, 37] },
      { id: 'entry', name: '현관 통로', rectXZ: [20, 30, 23, 37] },
      { id: 'dining', name: '식당', rectXZ: [23, 30, 30, 37] },
      { id: 'kitchen', name: '주방', rectXZ: [30, 30, 37, 37] },
    ],
    routes: [
      ...rooms.filter((r) => r.kind === 'gallery').map((r) => ({ id: r.id, rectXZ: [...r.rectXZ], floorY: 3 })),
      { id: 'front-hall', rectXZ: [20, 26, 23, 38], floorY: 3 },
      { id: 'courtyard-crossing', rectXZ: [20, 20, 23, 26], floorY: 3 },
      { id: 'courtyard-crosspath', rectXZ: [20, 22, 32, 25], floorY: 3 },
    ],
    waterRegions: [[41, 8, 48, 48], [8, 44, 41, 48]],
    photoWall: { wallX: 37, z: [21, 25], displaySlots, arrangement: '2x3', archive: '앨범에 이전 카드 보관' },
    landmarks: [
      { name: '물결마루 현관', at: [21, 4, 37] }, { name: '동백 화분', at: [19, 4, 21] },
      { name: '사진과 추억', at: [36, 4, 22] }, { name: '나쟈의 작은 콘솔', at: [36, 4, 25] },
      { name: '바닷가', at: [40, 1, 30] },
    ],
    cutaway: { roofGroups, wallGroups },
    cameras: [
      { id: 'common', name: '공용실', position: [38, 14, 45], target: [23.5, 4.2, 33.5], horizontalSpan: 28,
        hideGroups: ['common-roof', 'south-wall', 'east-common-wall'] },
      { id: 'courtyard', name: '중정', position: [23.5, 12, 34], target: [23.5, 4.2, 21.5], horizontalSpan: 29,
        hideGroups: ['common-roof', 'common-gallery-wall', 'south-gallery-roof', 'east-gallery-roof', 'west-gallery-roof', 'north-gallery-roof'] },
      { id: 'album', name: '사진 코너', position: [25, 9, 17], target: [34.5, 4.3, 23], horizontalSpan: 12,
        hideGroups: ['album-roof', 'east-gallery-roof', 'north-gallery-roof'] },
    ],
  };
  return { blocks, avatars, custom, signs, log: [], home };
}
