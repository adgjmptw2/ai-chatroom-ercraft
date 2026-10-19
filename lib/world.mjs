// Shared building world: a small voxel grid the members build in together.
// Flat grass ground at y=0 that can't be removed; blocks go at y=1..H-1.
// State lives in data/world.json; the server broadcasts changes to the 3D viewer
// (public/world.html) and describes the world to the AIs as text.

import fs from 'node:fs';
import path from 'node:path';
import { pick } from './i18n.mjs';
import { FURNITURE, FURNITURE_SHAPES, FACING_VECTOR, isFurniture } from '../public/world-materials.js';

export const SIZE = { x: 48, y: 32, z: 48 };

// name -> [map letter, color]. Letters are what the AIs see in world_look maps.
export const PALETTE = {
  stone: ['s', '#9a9da3'],
  cobble: ['c', '#76787d'],
  dirt: ['d', '#8b5a2b'],
  grass: ['g', '#5fa04e'],
  sand: ['a', '#e2d39b'],
  log: ['w', '#7a5230'],
  planks: ['p', '#c8a063'],
  leaves: ['l', '#3f8f3a'],
  brick: ['b', '#b5533c'],
  glass: ['G', '#cfeefc'],
  water: ['W', '#3d7fd8'],
  snow: ['n', '#f5f7fa'],
  gold: ['o', '#f2c230'],
  lamp: ['L', '#ffe9a0'],
  white: ['h', '#ececec'],
  black: ['k', '#26272b'],
  red: ['r', '#d23c3c'],
  orange: ['O', '#e8872e'],
  yellow: ['y', '#e8d23c'],
  green: ['e', '#3fbf5f'],
  blue: ['u', '#3c5fd2'],
  purple: ['v', '#8a4fd0'],
  pink: ['i', '#f28fb8'],
  // textured in the viewer
  bookshelf: ['B', '#8b5a2b'],
  door: ['D', '#9a6a3a'], // always a thin panel; members walk through it
};
const NAMES = Object.keys(PALETTE);
const LETTER = Object.fromEntries(NAMES.map((n) => [n, PALETTE[n][0]]));

// Stored block value: "name", "name/slab", "name/<stair|chair|table|bench|bed|workbench>/<n|e|s|w>", "door/<x|z>".
// Furniture fits one cell. Facing points towards its front; north is -z.
export const SHAPES = ['slab', 'stair', ...FURNITURE_SHAPES];
const FACINGS = ['n', 'e', 's', 'w'];
export const parseBlock = (v) => {
  const [type, shape, facing] = String(v).split('/');
  if (type === 'door') return { type, shape: 'door', facing: shape || '' };
  return { type, shape: shape || 'full', facing: facing || '' };
};

// Member-made blocks (block_define): an 8x8 pixel picture on every face.
const MAX_CUSTOM = 40;
const CUSTOM_NAME = /^[a-z][a-z0-9_]{1,19}$/;
const MAX_SIGNS = 60;
const MAX_SIGN_CHARS = 24;

const MAX_OPS = 60;          // entries per turn
const MAX_FILL = 4096;       // blocks in one fill/hollow/remove box
const MAX_CHANGES = 12000;   // blocks changed per turn
const MAX_BLOCKS = 80000;    // whole world
const MAX_SUMMARY_FURNITURE = 12;
const MAX_FURNITURE_SUMMARY_CHARS = 1200; // complete furniture section, including heading/omission notice
const MAX_PATH_POINTS = 256;
const MAX_NAV_NODES = 8192;
const MAX_DROP = 2;
const DIRECTIONS = Object.values(FACING_VECTOR);
const coordinates = ({ x, y, z }) => ({ x, y, z });
const samePosition = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

const key = (x, y, z) => `${x},${y},${z}`;
const inside = (x, y, z) => x >= 0 && x < SIZE.x && z >= 0 && z < SIZE.z && y >= 1 && y < SIZE.y;
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

// Texts the members read: validation errors, the build log, the summary and world_look maps.
// Coordinates, letters and the map layout are the same in every language.
const many = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const T = {
  ko: {
    badName: '이름은 영어 소문자·숫자·_로 2~20자 (예: moss_brick)',
    builtIn: (n) => `${n}은 원래 있는 블록이야`,
    customMax: (max) => `직접 만든 블록은 ${max}개까지야`,
    badColor: (c) => `색 "${c}"은 #rrggbb 형식이어야 해`,
    colorCount: 'colors에 글자→색을 1~12개 넣어 (예: {"a": "#556b2f"})',
    pixelRows: 'pixels는 8글자짜리 줄 8개야',
    dotNeedsClear: '"."(빈칸)는 clear: true일 때만 돼',
    pixelNoColor: (ch) => `pixels의 "${ch}"가 colors에 없어`,
    unknownBlock: (v, names) => `모르는 블록 "${v}" (쓸 수 있는 것: ${names})`,
    doorFacing: 'door의 facing은 x(동서로 뻗은 문) 또는 z(남북으로 뻗은 문)',
    unknownShape: (s) => `모르는 모양 "${s}" (full, ${SHAPES.join(', ')})`,
    stairFacing: 'stair의 facing은 n, e, s, w (높은 쪽 방향)',
    furnitureFacing: '가구의 facing은 n, e, s, w (앞쪽 방향)',
    badPoint: (label) => `${label} 좌표가 이상해`,
    boxMax: (max, vol) => `한 번에 ${max}칸까지야 (${vol}칸)`,
    outside: (x, y, z) => `월드 밖 (${x},${y},${z})`,
    signMax: (max) => `간판은 ${max}개까지야`,
    signFacing: '간판 facing은 n, e, s, w (글자가 보이는 쪽)',
    outsideRange: (x, y, z, mx, my) => `월드 밖 (${x},${y},${z}). x,z는 0~${mx}, y는 1~${my}`,
    unknownOp: (k) => `모르는 작업 "${k}" (place, fill, hollow, remove, sign)`,
    turnMax: (max) => `한 턴에 ${max}칸까지만 바뀌어서 나머지는 안 됐어`,
    placed: (n) => `${n}칸 놓음`,
    removed: (n) => `${n}칸 지움`,
    signs: (n) => `간판 ${n}개`,
    sep: ', ',
    me: '(나)',
    size: (mx, mz, my) => `크기 x 0~${mx}, z 0~${mz}, 높이 y 1~${my} (y=0은 잔디 땅). `,
    blocks: (n) => `블록 ${n}개`,
    span: (lo, hi) => ` · 쓰인 범위 (${lo})~(${hi})`,
    kinds: '종류',
    signList: '간판',
    furnitureList: `가구 (좌표 x,y,z · shape/facing · 점유 상태; 최대 ${MAX_SUMMARY_FURNITURE}개/${MAX_FURNITURE_SUMMARY_CHARS}자; 사용: useFurniture:[x,y,z])`,
    furnitureFree: '비어 있음',
    furnitureOccupied: (name) => `사용 중: ${name}`,
    furnitureMore: (n) => `…가구 ${n}개 생략`,
    more: (n) => ` …외 ${n}개`,
    custom: '직접 만든 블록',
    glow: ', 빛남',
    clear: ', 투명',
    positions: '캐릭터 위치(x,z)',
    recent: '최근 작업',
    legend: (letters) => `글자: ${letters} *=직접 만든 블록 .=빈칸 (반블록·계단은 재료 글자로 보여)`,
    layer: (y, xa, xb, za, zb) => `[층 y=${y}] x ${xa}~${xb}, z ${za}~${zb}`,
    top: (xa, xb, za, zb) => `[위에서 본 지도] x ${xa}~${xb}, z ${za}~${zb}. 맨 위 블록 글자와 높이(0~9, a=10 … v=31, .=맨땅)`,
  },
  en: {
    badName: 'The name must be 2-20 lowercase letters, digits or _ (e.g. moss_brick)',
    builtIn: (n) => `${n} is already a built-in block`,
    customMax: (max) => `Up to ${max} custom blocks`,
    badColor: (c) => `Color "${c}" must be #rrggbb`,
    colorCount: 'Put 1-12 letter→color pairs in colors (e.g. {"a": "#556b2f"})',
    pixelRows: 'pixels must be 8 rows of 8 characters',
    dotNeedsClear: '"." (empty) only works with clear: true',
    pixelNoColor: (ch) => `"${ch}" in pixels is not in colors`,
    unknownBlock: (v, names) => `Unknown block "${v}" (you can use: ${names})`,
    doorFacing: 'door facing is x (a door running east-west) or z (a door running north-south)',
    unknownShape: (s) => `Unknown shape "${s}" (full, ${SHAPES.join(', ')})`,
    stairFacing: 'stair facing is n, e, s or w (the high side)',
    furnitureFacing: 'Furniture facing is n, e, s or w (the front side)',
    badPoint: (label) => `"${label}" coordinates look wrong`,
    boxMax: (max, vol) => `Up to ${max} cells at once (${many(vol, 'cell')})`,
    outside: (x, y, z) => `Outside the world (${x},${y},${z})`,
    signMax: (max) => `Up to ${max} signs`,
    signFacing: 'sign facing is n, e, s or w (the side the text faces)',
    outsideRange: (x, y, z, mx, my) => `Outside the world (${x},${y},${z}). x,z are 0~${mx}, y is 1~${my}`,
    unknownOp: (k) => `Unknown op "${k}" (place, fill, hollow, remove, sign)`,
    turnMax: (max) => `Only ${max} cells can change per turn, so the rest didn't happen`,
    placed: (n) => `placed ${many(n, 'block')}`,
    removed: (n) => `removed ${many(n, 'block')}`,
    signs: (n) => many(n, 'sign'),
    sep: ', ',
    me: '(you)',
    size: (mx, mz, my) => `Size x 0~${mx}, z 0~${mz}, height y 1~${my} (y=0 is the grass ground). `,
    blocks: (n) => many(n, 'block'),
    span: (lo, hi) => ` · used area (${lo})~(${hi})`,
    kinds: 'Types',
    signList: 'Signs',
    furnitureList: `Furniture (coordinates x,y,z · shape/facing · occupancy; up to ${MAX_SUMMARY_FURNITURE} entries/${MAX_FURNITURE_SUMMARY_CHARS} chars; use: useFurniture:[x,y,z])`,
    furnitureFree: 'unoccupied',
    furnitureOccupied: (name) => `in use: ${name}`,
    furnitureMore: (n) => `…${n} furniture entries omitted`,
    more: (n) => ` …and ${n} more`,
    custom: 'Custom blocks',
    glow: ', glows',
    clear: ', see-through',
    positions: 'Positions (x,z)',
    recent: 'Recent work',
    legend: (letters) => `Letters: ${letters} *=custom block .=empty (slabs and stairs show their material's letter)`,
    layer: (y, xa, xb, za, zb) => `[Layer y=${y}] x ${xa}~${xb}, z ${za}~${zb}`,
    top: (xa, xb, za, zb) => `[Top view] x ${xa}~${xb}, z ${za}~${zb}. Top block letter and height (0~9, a=10 … v=31, .=bare ground)`,
  },
  ja: {
    badName: '名前は英小文字・数字・_で2~20文字(例: moss_brick)',
    builtIn: (n) => `${n}は元からあるブロックだよ`,
    customMax: (max) => `自作ブロックは${max}個まで`,
    badColor: (c) => `色 "${c}" は #rrggbb 形式にして`,
    colorCount: 'colorsに文字→色を1~12個入れて(例: {"a": "#556b2f"})',
    pixelRows: 'pixelsは8文字の行を8つにして',
    dotNeedsClear: '"."(空き)は clear: true のときだけ使える',
    pixelNoColor: (ch) => `pixelsの"${ch}"がcolorsにない`,
    unknownBlock: (v, names) => `知らないブロック "${v}" (使えるもの: ${names})`,
    doorFacing: 'doorのfacingは x(東西に延びるドア)か z(南北に延びるドア)',
    unknownShape: (s) => `知らない形 "${s}" (full, ${SHAPES.join(', ')})`,
    stairFacing: 'stairのfacingは n, e, s, w (高い側の向き)',
    furnitureFacing: '家具のfacingは n, e, s, w (正面の向き)',
    badPoint: (label) => `${label}の座標がおかしい`,
    boxMax: (max, vol) => `一度に${max}マスまで(${vol}マス)`,
    outside: (x, y, z) => `ワールドの外 (${x},${y},${z})`,
    signMax: (max) => `看板は${max}個まで`,
    signFacing: '看板のfacingは n, e, s, w (文字が見える側)',
    outsideRange: (x, y, z, mx, my) => `ワールドの外 (${x},${y},${z})。x,zは0~${mx}、yは1~${my}`,
    unknownOp: (k) => `知らない操作 "${k}" (place, fill, hollow, remove, sign)`,
    turnMax: (max) => `1ターンで変えられるのは${max}マスまでだから、残りはできなかった`,
    placed: (n) => `${n}マス置いた`,
    removed: (n) => `${n}マス消した`,
    signs: (n) => `看板${n}個`,
    sep: '、',
    me: '(自分)',
    size: (mx, mz, my) => `サイズ x 0~${mx}, z 0~${mz}, 高さ y 1~${my} (y=0は草の地面)。`,
    blocks: (n) => `ブロック${n}個`,
    span: (lo, hi) => ` · 使われてる範囲 (${lo})~(${hi})`,
    kinds: '種類',
    signList: '看板',
    furnitureList: `家具 (座標 x,y,z · shape/facing · 使用状況; 最大${MAX_SUMMARY_FURNITURE}件/${MAX_FURNITURE_SUMMARY_CHARS}文字; 使用: useFurniture:[x,y,z])`,
    furnitureFree: '空き',
    furnitureOccupied: (name) => `使用中: ${name}`,
    furnitureMore: (n) => `…家具${n}件を省略`,
    more: (n) => ` …ほか${n}個`,
    custom: '自作ブロック',
    glow: ', 光る',
    clear: ', 透明',
    positions: 'キャラの位置(x,z)',
    recent: '最近の作業',
    legend: (letters) => `文字: ${letters} *=自作ブロック .=空き (ハーフブロック・階段は素材の文字で表示)`,
    layer: (y, xa, xb, za, zb) => `[層 y=${y}] x ${xa}~${xb}, z ${za}~${zb}`,
    top: (xa, xb, za, zb) => `[上から見た地図] x ${xa}~${xb}, z ${za}~${zb}。一番上のブロックの文字と高さ(0~9, a=10 … v=31, .=地面)`,
  },
};
const tx = () => pick(T);

export class World {
  constructor(home, ids) {
    this.file = path.join(home, 'data', 'world.json');
    const saved = readJson(this.file, {});
    this.blocks = new Map(Object.entries(saved.blocks || {})); // "x,y,z" -> block name
    this.avatars = saved.avatars || {};
    this.log = saved.log || []; // recent ops: {by, at, text}
    this.custom = saved.custom || {}; // name -> {pixels: [8 strings], colors: {ch: '#rrggbb'}, glow, clear, by}
    this.signs = saved.signs || {}; // "x,y,z" -> {text, facing, width, bg, color, glow, by}
    this.home = safeHome(saved.home);
    // Animation is transient. Never trust or replay paths from a saved world.
    this.movements = new Map();
    this.moveSequence = Date.now();
    // Spawn points near the corners, facing the middle.
    const spawn = [[6, 6], [41, 6], [6, 41], [41, 41]];
    ids.forEach((id, i) => { this.avatars[id] ??= { x: spawn[i % 4][0], z: spawn[i % 4][1] }; });
    this.avatars = this.resolveAvatars();
    this.saveTimer = null;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        writeWorld(this.file, JSON.stringify({ blocks: Object.fromEntries(this.blocks), avatars: this.avatars, log: this.log.slice(-60), custom: this.custom, signs: this.signs, ...(this.home ? { home: safeHome(this.home) } : {}) }));
        this.saveError = null;
      } catch (error) {
        // A failed delayed write must neither truncate the previous snapshot
        // nor crash the server. The next change/save can retry the current state.
        this.saveError = error;
      }
    }, 400);
  }

  // Shutdown drains the delayed save before the process can acknowledge exit.
  flush() {
    if (!this.saveTimer && !this.saveError) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      writeWorld(this.file, JSON.stringify({ blocks: Object.fromEntries(this.blocks), avatars: this.avatars, log: this.log.slice(-60), custom: this.custom, signs: this.signs, ...(this.home ? { home: safeHome(this.home) } : {}) }));
      this.saveError = null;
    } catch (error) { this.saveError = error; throw error; }
  }

  // Highest block for top-view maps. Avatar placement uses standingY instead, so
  // a roof does not pull a member out of an otherwise walkable room.
  topY(x, z) {
    for (let y = SIZE.y - 1; y >= 1; y--) {
      const v = this.blocks.get(key(x, y, z));
      if (v && parseBlock(v).type !== 'door') return y;
    }
    return 0;
  }

  // Physical feet height, not the serialized avatar y (= feet + 1). Prefer the
  // current storey, allow a one-block step up, and require space for the body.
  // Doors and water are traversable. Furniture is used, never stood inside.
  clearAt(x, z, feet, height = 1.65, blocks = this.blocks, ignore = '') {
    if (![x, z, feet].every(Number.isFinite) || x < 0 || z < 0 || x >= SIZE.x || z >= SIZE.z || feet < 0 || feet + height > SIZE.y) return false;
    for (let y = Math.max(1, Math.floor(feet) + 1); y <= Math.min(SIZE.y - 1, Math.ceil(feet + height)); y++) {
      const k = key(x, y, z), v = blocks.get(k);
      if (!v || k === ignore) continue;
      const p = parseBlock(v);
      if (p.type === 'door' || p.type === 'water') continue;
      const top = y - 1 + (p.shape === 'slab' ? 0.5 : isFurniture(p.shape) ? FURNITURE[p.shape].height : 1);
      if (top > feet + 0.001 && y - 1 < feet + height - 0.001) return false;
    }
    return true;
  }

  standingY(x, z, preferred = 0, blocks = this.blocks, maxStep = 1) {
    const surfaces = [0];
    for (let y = 1; y < SIZE.y; y++) {
      const v = blocks.get(key(x, y, z));
      if (!v) continue;
      const p = parseBlock(v);
      if (p.type === 'door' || p.type === 'water' || isFurniture(p.shape)) continue;
      surfaces.push(p.shape === 'slab' ? y - 0.5 : y);
    }
    surfaces.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
    return surfaces.find((feet) => feet <= preferred + maxStep && this.clearAt(x, z, feet, 1.65, blocks)) ?? null;
  }

  standingPosition(a, blocks = this.blocks) {
    const x = clamp(int(a.x), 0, SIZE.x - 1), z = clamp(int(a.z), 0, SIZE.z - 1);
    const preferred = Math.max(0, Number.isFinite(a.y) ? a.y - 1 : 0);
    // Usually the current/return column. Search outward only after a build
    // blocks it; the world is small and this never runs in a frame loop.
    for (let r = 0; r < Math.max(SIZE.x, SIZE.z); r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const px = x + dx, pz = z + dz;
        if (px < 0 || pz < 0 || px >= SIZE.x || pz >= SIZE.z) continue;
        const feet = this.standingY(px, pz, preferred, blocks);
        if (feet !== null) return { x: px, y: feet + 1, z: pz, posture: 'stand', facing: a.facing || 's' };
      }
    }
    // Fully filled worlds have no accessible floor. Keep a valid surface as a
    // last resort; ordinary roofed interiors always take the floor above.
    return { x, z, y: (this.standingY(x, z, preferred, blocks, Infinity) ?? 0) + 1, posture: 'stand', facing: a.facing || 's' };
  }

  // Only endpoints are occupied: reserving every historical path cell would
  // deadlock a narrow hall after the server has already committed its destination.
  occupiedAt(id, position) {
    return Object.entries(this.avatars).some(([other, a]) => other !== id && a.x === position.x && a.z === position.z && Math.abs((a.y ?? 1) - position.y) < 1.5);
  }

  // A seat is reached/exited through one cardinal neighbour on a real floor.
  // The surface offset is a posture change, not an extra walkable stair/roof.
  furnitureTransition(approach, pose, at, entering) {
    if (Math.abs(approach.x - pose.x) + Math.abs(approach.z - pose.z) !== 1) return false;
    const delta = entering ? at[1] - approach.y : approach.y - at[1];
    if (delta > 1 || delta < -MAX_DROP) return false;
    const height = pose.posture === 'lie' ? 0.65 : 1.1;
    return this.clearAt(approach.x, approach.z, approach.y - 1, Math.max(1.65, pose.y - approach.y + height))
      && this.clearAt(pose.x, pose.z, pose.y - 1, Math.max(height, approach.y - pose.y + 1.65), this.blocks, at.join(','));
  }

  // Request-time BFS over supported (x,y,z) positions, never a server tick.
  // The bound covers a normal house but rejects excessively long/complex mazes.
  navigationPath(a, isGoal) {
    const surfaces = new Map();
    const floors = (x, z) => {
      const k = `${x},${z}`;
      if (!surfaces.has(k)) {
        const ys = [];
        if (x >= 0 && z >= 0 && x < SIZE.x && z < SIZE.z) {
          for (let y = 0; y < SIZE.y; y++) {
            const p = parseBlock(this.blocks.get(key(x, y, z)));
            if (y && (!this.blocks.has(key(x, y, z)) || ['door', 'water'].includes(p.type) || isFurniture(p.shape))) continue;
            const feet = y && p.shape === 'slab' ? y - 0.5 : y;
            if (this.clearAt(x, z, feet)) ys.push({ x, y: feet + 1, z });
          }
        }
        surfaces.set(k, ys);
      }
      return surfaces.get(k);
    };
    const nodes = [], seen = new Set();
    const enqueue = (p, parent, depth) => {
      const k = key(p.x, p.y, p.z);
      if (seen.has(k) || nodes.length >= MAX_NAV_NODES || depth > MAX_PATH_POINTS - 1) return;
      seen.add(k); nodes.push({ p, parent, depth });
    };
    const current = { x: a.x, y: a.y ?? 1, z: a.z };
    const seat = a.furniture && this.furniturePose(a.furniture.at);
    const seated = seat && !seat.error && seat.posture !== 'work' && samePosition(current, seat);
    if (seated) {
      // The first node is the actual seated point, not a remote returnTo.
      nodes.push({ p: current, parent: -1, depth: 1 });
      seen.add(key(current.x, current.y, current.z));
      for (const [dx, dz] of DIRECTIONS) for (const p of floors(current.x + dx, current.z + dz)) {
        if (this.furnitureTransition(p, seat, a.furniture.at, false)) enqueue(p, 0, 2);
      }
    } else {
      const start = floors(current.x, current.z).find((p) => samePosition(p, current));
      if (!start) return null;
      enqueue(start, -1, 1);
    }
    for (let i = seated ? 1 : 0; i < nodes.length; i++) {
      const { p, depth } = nodes[i];
      if (isGoal(p)) {
        const route = [];
        for (let n = i; n >= 0; n = nodes[n].parent) route.push(coordinates(nodes[n].p));
        return route.reverse();
      }
      for (const [dx, dz] of DIRECTIONS) for (const next of floors(p.x + dx, p.z + dz)) {
        const delta = next.y - p.y;
        if (delta > 1 || delta < -MAX_DROP) continue;
        // Check the vertical sweep as well as both endpoints: stepping up
        // under a low lintel or dropping through an overhang is not a route.
        if (!this.clearAt(p.x, p.z, p.y - 1, 1.65 + Math.max(0, delta))
          || !this.clearAt(next.x, next.z, next.y - 1, 1.65 + Math.max(0, -delta))) continue;
        enqueue(next, i, depth + 1);
      }
    }
    return null;
  }

  commitMovement(id, avatar, route) {
    this.avatars[id] = avatar;
    this.moveSequence = Math.max(Date.now(), this.moveSequence + 1);
    this.movements.set(id, { avatar, moveId: this.moveSequence, path: route.map(coordinates) });
    this.save();
  }

  furniturePose(at, blocks = this.blocks) {
    if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isSafeInteger) || !inside(...at)) return { error: 'invalid_target' };
    const [x, y, z] = at, k = key(x, y, z), block = blocks.get(k);
    const { shape, facing } = parseBlock(block);
    if (!isFurniture(shape)) return { error: 'not_furniture' };
    const spec = FURNITURE[shape], front = FACINGS.includes(facing) ? facing : 'n';
    if (y > 1) {
      const support = parseBlock(blocks.get(key(x, y - 1, z)));
      if (!blocks.has(key(x, y - 1, z)) || ['door', 'water'].includes(support.type) || support.shape === 'slab' || isFurniture(support.shape)) return { error: 'unsupported' };
    }
    if (spec.posture === 'work') {
      const [dx, dz] = FACING_VECTOR[front], px = x + dx, pz = z + dz;
      const feet = this.standingY(px, pz, y - 1, blocks, 0);
      if (feet === null || Math.abs(feet - (y - 1)) > 0.5) return { error: 'blocked' };
      return { x: px, y: feet + 1, z: pz, posture: spec.posture, facing: FACINGS[(FACINGS.indexOf(front) + 2) % 4], shape, block };
    }
    const feet = y - 1 + spec.surface;
    if (!this.clearAt(x, z, feet, spec.posture === 'lie' ? 0.65 : 1.1, blocks, k)) return { error: 'blocked' };
    return { x, y: feet + 1, z, posture: spec.posture, facing: front, shape, block };
  }

  // Returns a fresh serializable map. Also used against pending plan blocks so
  // plan persistence stays atomic, including avatars invalidated by that stage.
  resolveAvatars(blocks = this.blocks, invalidated = new Set()) {
    const occupied = new Set();
    return Object.fromEntries(Object.entries(this.avatars).map(([id, a]) => {
      const f = a.furniture, k = Array.isArray(f?.at) ? f.at.join(',') : '';
      if (f && !occupied.has(k) && !invalidated.has(k)) {
        const pose = this.furniturePose(f.at, blocks);
        if (!pose.error && pose.block === f.block) {
          occupied.add(k);
          const { shape, block, ...position } = pose;
          return [id, { ...position, furniture: { ...f, shape } }];
        }
      }
      return [id, this.standingPosition(f?.returnTo || a, blocks)];
    }));
  }

  // at: [x,y,z] | {x,y,z}; null releases. No LLM call or animation loop.
  // Return {ok:true, avatar} or {ok:false, error:<stable machine code>}.
  useFurniture(id, at) {
    if (!Object.hasOwn(this.avatars, id)) return { ok: false, error: 'unknown_avatar' };
    const a = this.avatars[id];
    if (at === null) {
      if (!a.furniture) return { ok: true, avatar: this.avatarView()[id] };
      const target = a.furniture.returnTo;
      const route = target && this.navigationPath(a, (p) => p.x === target.x && p.z === target.z && (!Number.isFinite(target.y) || p.y === target.y) && !this.occupiedAt(id, p))
        || this.navigationPath(a, (p) => !samePosition(p, a) && !this.occupiedAt(id, p));
      if (!route) return { ok: false, error: 'unreachable' };
      this.commitMovement(id, { ...route.at(-1), posture: 'stand', facing: a.facing || 's' }, route);
      return { ok: true, avatar: this.avatarView()[id] };
    }
    const point = Array.isArray(at) ? at : at && typeof at === 'object' ? [at.x, at.y, at.z] : [];
    const pose = this.furniturePose(point);
    if (pose.error) return { ok: false, error: pose.error };
    const k = point.join(',');
    if (a.furniture?.at?.join(',') === k && a.furniture.block === pose.block && samePosition(a, pose)) return { ok: true, avatar: this.avatarView()[id] };
    for (const [other, av] of Object.entries(this.avatars)) {
      if (other === id) continue;
      if (av.furniture?.at?.join(',') === k || av.x === pose.x && av.z === pose.z && Math.abs((av.y ?? 1) - pose.y) < 1.5) return { ok: false, error: 'occupied' };
    }
    const route = this.navigationPath(a, pose.posture === 'work'
      ? (p) => samePosition(p, pose)
      : (p) => this.furnitureTransition(p, pose, point, true));
    if (!route) return { ok: false, error: 'unreachable' };
    if (!samePosition(route.at(-1), pose)) route.push(coordinates(pose));
    const { shape, block, ...position } = pose;
    const returnTo = a.furniture?.returnTo || { x: a.x, y: a.y, z: a.z, facing: a.facing };
    this.commitMovement(id, { ...position, furniture: { at: [...point], shape, block, returnTo: { ...returnTo } } }, route);
    return { ok: true, avatar: this.avatarView()[id] };
  }

  // Register a member-made block. Returns its name, or throws with a message for the member.
  define(def, by) {
    const d = def && typeof def === 'object' ? def : {};
    const name = String(d.name ?? '').trim().toLowerCase();
    if (!CUSTOM_NAME.test(name)) throw new Error(tx().badName);
    if (PALETTE[name]) throw new Error(tx().builtIn(name));
    if (!this.custom[name] && Object.keys(this.custom).length >= MAX_CUSTOM) throw new Error(tx().customMax(MAX_CUSTOM));
    const colors = {};
    for (const [ch, c] of Object.entries(d.colors || {})) {
      if (ch.length !== 1 || ch === '.') continue;
      if (!/^#[0-9a-fA-F]{6}$/.test(String(c))) throw new Error(tx().badColor(c));
      colors[ch] = String(c).toLowerCase();
    }
    if (!Object.keys(colors).length || Object.keys(colors).length > 12) throw new Error(tx().colorCount);
    const rows = Array.isArray(d.pixels) ? d.pixels.map(String) : [];
    if (rows.length !== 8 || rows.some((r) => [...r].length !== 8)) throw new Error(tx().pixelRows);
    const clear = d.clear === true;
    for (const r of rows) for (const ch of r) {
      if (ch === '.' ? !clear : !colors[ch]) throw new Error(ch === '.' ? tx().dotNeedsClear : tx().pixelNoColor(ch));
    }
    this.custom[name] = { pixels: rows, colors, glow: d.glow === true, clear, by, at: Date.now() };
    this.save();
    return name;
  }
  isBlock(name) { return !!(PALETTE[name] || this.custom[name]); }
  blockNames() { return [...NAMES, ...Object.keys(this.custom)]; }

  view() {
    return {
      size: SIZE,
      palette: Object.fromEntries(NAMES.map((n) => [n, PALETTE[n][1]])),
      custom: this.custom,
      signs: this.signs,
      blocks: [...this.blocks].map(([k, t]) => [...k.split(',').map(Number), t]),
      avatars: this.avatarView(),
      ...(this.home ? { home: safeHome(this.home) } : {}),
    };
  }
  avatarView() {
    // path includes the source and destination; y is always feet + 1. Clients
    // snap/record moveId on their first snapshot and animate only later changes.
    // A new avatar object after build reconciliation invalidates its old route.
    return Object.fromEntries(Object.entries(this.avatars).map(([id, a]) => [id, {
      x: a.x, z: a.z, y: a.y, posture: a.posture || 'stand', facing: a.facing || 's',
      ...(a.furniture ? { furniture: { at: [...a.furniture.at], shape: a.furniture.shape } } : {}),
      ...(this.movements.get(id)?.avatar === a ? { moveId: this.movements.get(id).moveId, path: this.movements.get(id).path.map(coordinates) } : {}),
    }]));
  }

  // A compiled plan stage is an all-or-nothing addition, never a repair or
  // overwrite. Preflight the complete input before changing blocks/log/save.
  applyCells(cells, by) {
    if (!Array.isArray(cells) || cells.length > 600) throw new Error('Plan stage must contain at most 600 cells');
    const pending = new Map();
    for (const cell of cells) {
      if (!Array.isArray(cell) || cell.length !== 4) throw new Error('Invalid plan cell');
      const [x, y, z, block] = cell;
      if (![x, y, z].every(Number.isSafeInteger) || !inside(x, y, z)) throw new Error('Plan cell outside world or not integer');
      if (typeof block !== 'string') throw new Error('Invalid encoded plan block');
      const parts = block.split('/');
      const valid = Object.hasOwn(PALETTE, parts[0]) && (parts[0] === 'door'
        ? parts.length === 2 && ['x', 'z'].includes(parts[1])
        : parts.length === 1 || parts.length === 2 && parts[1] === 'slab'
          || parts.length === 3 && (parts[1] === 'stair' || isFurniture(parts[1])) && FACINGS.includes(parts[2]));
      if (!valid) throw new Error('Invalid encoded plan block');
      const k = key(x, y, z);
      if (pending.has(k)) throw new Error('Duplicate plan cell');
      if (Object.hasOwn(this.signs, k)) throw new Error('Plan cell conflicts with an existing sign');
      if (this.blocks.has(k) && this.blocks.get(k) !== block) throw new Error('Plan cell conflicts with an existing block');
      pending.set(k, [x, y, z, block]);
    }
    const changes = [...pending].filter(([k]) => !this.blocks.has(k)).map(([, cell]) => cell);
    if (this.blocks.size + changes.length > MAX_BLOCKS) throw new Error('Plan stage exceeds world block limit');
    if (changes.length || this.saveTimer) {
      const nextBlocks = new Map(this.blocks);
      for (const [x, y, z, block] of changes) nextBlocks.set(key(x, y, z), block);
      const nextLog = changes.length ? [...this.log, { by, at: Date.now(), text: `${tx().placed(changes.length)} (${describeSpan(changes)})` }].slice(-60) : this.log;
      // Publish durable world state before the manager can persist stage
      // progress. On any I/O failure memory and the existing save timer stay
      // intact; no successful stage is returned ahead of its world write.
      const nextAvatars = this.resolveAvatars(nextBlocks);
      const json = JSON.stringify({ blocks: Object.fromEntries(nextBlocks), avatars: nextAvatars, log: nextLog, custom: this.custom, signs: this.signs, ...(this.home ? { home: safeHome(this.home) } : {}) });
      const temp = `${this.file}.plan-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      let fd, created = false;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        created = true;
        fs.writeFileSync(fd, json, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temp, this.file);
      } catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve original error */ } }
        if (created) { try { fs.unlinkSync(temp); } catch { /* preserve original error */ } }
        throw error;
      }
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveError = null;
      this.blocks = nextBlocks;
      this.avatars = nextAvatars;
      this.log = nextLog;
    }
    return { changes, notes: [], signs: 0 };
  }

  // Apply one member's "build" list. Returns {changes: [[x,y,z,name|null]], notes: [..],
  // signs: number of signs placed/changed/removed}.
  apply(ops, by) {
    const changes = new Map();
    const invalidated = new Set();
    const notes = [];
    let budget = MAX_CHANGES;
    let signs = 0;
    const set = (x, y, z, t) => {
      if (!inside(x, y, z) || budget <= 0) return;
      const k = key(x, y, z);
      if (!t && this.signs[k]) { delete this.signs[k]; signs++; } // clearing a cell takes its sign too
      const cur = this.blocks.get(k) ?? null;
      if (cur === t) return;
      if (t && !cur && this.blocks.size >= MAX_BLOCKS) return;
      if (cur && isFurniture(parseBlock(cur).shape)) invalidated.add(k);
      if (t) this.blocks.set(k, t); else this.blocks.delete(k);
      changes.set(k, t);
      budget--;
    };
    // Block name plus the op's shape/facing, encoded as stored (see parseBlock).
    const blockOf = (v, op) => {
      const n = String(v ?? '').trim().toLowerCase();
      if (!this.isBlock(n)) throw new Error(tx().unknownBlock(v, this.blockNames().join(', ')));
      const facing = String(op.facing ?? '').trim().toLowerCase();
      if (n === 'door') {
        if (facing && !['x', 'z', ...FACINGS].includes(facing)) throw new Error(tx().doorFacing);
        const f = facing === 'n' || facing === 's' ? 'x' : facing === 'e' || facing === 'w' ? 'z' : facing;
        return f ? `door/${f}` : 'door';
      }
      const shape = String(op.shape ?? 'full').trim().toLowerCase();
      if (shape === 'full' || !shape) return n;
      if (!SHAPES.includes(shape)) throw new Error(tx().unknownShape(op.shape));
      if (shape === 'slab') return `${n}/slab`;
      if (facing && !FACINGS.includes(facing)) throw new Error(isFurniture(shape) ? tx().furnitureFacing : tx().stairFacing);
      return `${n}/${shape}/${facing || 'n'}`;
    };
    const point = (p, label) => {
      const [x, y, z] = Array.isArray(p) ? p.map(int) : [int(p?.x), int(p?.y), int(p?.z)];
      if ([x, y, z].some(Number.isNaN)) throw new Error(tx().badPoint(label));
      return [x, y, z];
    };
    const box = (op) => {
      const a = point(op.from, 'from');
      const b = point(op.to, 'to');
      const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
      const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]));
      const vol = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
      if (vol > MAX_FILL) throw new Error(tx().boxMax(MAX_FILL, vol));
      return [lo, hi];
    };
    for (const op of (Array.isArray(ops) ? ops : [ops]).slice(0, MAX_OPS)) {
      if (!op || typeof op !== 'object') continue;
      try {
        const kind = String(op.op || 'place');
        if (kind === 'sign') {
          const [x, y, z] = point(op.at ?? op, 'at');
          if (!inside(x, y, z)) throw new Error(tx().outside(x, y, z));
          const k = key(x, y, z);
          const text = [...String(op.text ?? '').replace(/\s+/g, ' ').trim()].slice(0, MAX_SIGN_CHARS).join('');
          if (!text) { if (this.signs[k]) { delete this.signs[k]; signs++; } continue; }
          if (!this.signs[k] && Object.keys(this.signs).length >= MAX_SIGNS) throw new Error(tx().signMax(MAX_SIGNS));
          const facing = String(op.facing ?? 's').trim().toLowerCase();
          if (!FACINGS.includes(facing)) throw new Error(tx().signFacing);
          const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? '')) ? String(v).toLowerCase() : d);
          const width = clamp(int(op.width ?? Math.ceil([...text].length / 2)), 1, 6); // ~2 Korean letters a cell
          this.signs[k] = { text, facing, width, bg: hex(op.bg, '#6b4a2a'), color: hex(op.color, '#fff4d6'), glow: op.glow === true, by };
          signs++;
          continue;
        }
        if (kind === 'place' || kind === 'remove' && !op.from) {
          const [x, y, z] = point(op.at ?? op, 'at');
          if (!inside(x, y, z)) throw new Error(tx().outsideRange(x, y, z, SIZE.x - 1, SIZE.y - 1));
          set(x, y, z, kind === 'remove' ? null : blockOf(op.block, op));
        } else if (kind === 'fill' || kind === 'hollow' || kind === 'remove') {
          const [lo, hi] = box(op);
          const t = kind === 'remove' ? null : blockOf(op.block, op);
          for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
            const edge = x === lo[0] || x === hi[0] || y === lo[1] || y === hi[1] || z === lo[2] || z === hi[2];
            if (kind === 'hollow' && !edge) set(x, y, z, null);
            else set(x, y, z, t);
          }
        } else {
          throw new Error(tx().unknownOp(kind));
        }
      } catch (e) {
        notes.push(e.message);
      }
    }
    if (budget <= 0) notes.push(tx().turnMax(MAX_CHANGES));
    const out = [...changes].map(([k, t]) => [...k.split(',').map(Number), t]);
    if (out.length || signs) {
      if (out.length) this.avatars = this.resolveAvatars(this.blocks, invalidated);
      const t = tx();
      const placed = out.filter((c) => c[3]).length;
      const parts = [];
      if (placed) parts.push(t.placed(placed));
      if (out.length - placed) parts.push(t.removed(out.length - placed));
      if (signs) parts.push(t.signs(signs));
      this.log.push({ by, at: Date.now(), text: `${parts.join(t.sep)}${out.length ? ` (${describeSpan(out)})` : ''}` });
      this.log = this.log.slice(-60);
      this.save();
    }
    return { changes: out, notes, signs };
  }

  move(id, to) {
    const x = int(Array.isArray(to) ? to[0] : to?.x);
    const z = int(Array.isArray(to) ? to[1] : to?.z);
    if (Number.isNaN(x) || Number.isNaN(z)) return false;
    if (['__proto__', 'constructor', 'prototype'].includes(id)) return false;
    const px = clamp(x, 0, SIZE.x - 1), pz = clamp(z, 0, SIZE.z - 1);
    const current = this.avatars[id];
    // Legacy callers may register a previously unknown avatar via move().
    // It has no previous location to animate; still require a supported spawn.
    let route;
    if (!current) {
      const feet = this.standingY(px, pz, 0);
      if (feet === null) return false;
      route = [{ x: px, y: feet + 1, z: pz }];
    } else {
      route = this.navigationPath(current, (p) => p.x === px && p.z === pz && !this.occupiedAt(id, p));
      if (!route) return false;
      if (route.length === 1 && !current.furniture) return true;
    }
    this.commitMovement(id, { ...route.at(-1), posture: 'stand', facing: current?.facing || 's' }, route);
    return true;
  }

  // Short summary that goes into every turn.
  summary(selfId, nameOf) {
    const counts = {};
    const occupants = new Map();
    for (const [id, a] of Object.entries(this.avatars)) {
      const f = a.furniture;
      if (f && this.blocks.get(f.at.join(',')) === f.block) occupants.set(f.at.join(','), id);
    }
    const self = this.avatars[selfId];
    const furniture = [];
    let furnitureCount = 0;
    let lo = null, hi = null;
    for (const [k, v] of this.blocks) {
      const parsed = parseBlock(v), t = parsed.type;
      counts[t] = (counts[t] || 0) + 1;
      const p = k.split(',').map(Number);
      lo = lo ? lo.map((v, i) => Math.min(v, p[i])) : p;
      hi = hi ? hi.map((v, i) => Math.max(v, p[i])) : p;
      if (isFurniture(parsed.shape)) {
        furnitureCount++;
        const occupant = occupants.get(k);
        // Keep occupied furniture discoverable even when the world has many
        // pieces; then prefer nearby pieces. Retain only a bounded candidate list.
        furniture.push({ at: k, p, shape: parsed.shape, facing: parsed.facing || 'n', occupant,
          rank: occupant !== undefined ? (occupant === selfId ? 0 : 1) : 2,
          distance: self ? Math.abs(p[0] - self.x) + Math.abs(p[2] - self.z) + Math.abs(p[1] - (self.y ?? 1)) : 0 });
        furniture.sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.p[0] - b.p[0] || a.p[1] - b.p[1] || a.p[2] - b.p[2]);
        if (furniture.length > MAX_SUMMARY_FURNITURE) furniture.pop();
      }
    }
    const t = tx();
    const pos = Object.entries(this.avatarView()).map(([id, a]) => `${nameOf(id)}${id === selfId ? t.me : ''} (${a.x},${a.z}) posture:${a.posture}${a.furniture ? ` ${a.furniture.shape}@${a.furniture.at.join(',')}` : ''}`).join(', ');
    const lines = [`${t.size(SIZE.x - 1, SIZE.z - 1, SIZE.y - 1)}${t.blocks(this.blocks.size)}${this.blocks.size ? t.span(lo.join(','), hi.join(',')) : ''}`];
    const home = safeHome(this.home);
    if (home) {
      const rooms = [...Object.values(home.landmarks || {}), ...Object.values(home.rooms || {})].slice(0, 17).map((r) => {
        const rect = r.rectXZ;
        const at = r.center || r.at || r.spawn || (Array.isArray(rect) && rect.length === 4 ? [Math.floor((rect[0] + rect[2]) / 2), (home.floorY || 0) + 1, Math.floor((rect[1] + rect[3]) / 2)] : null);
        const p = Array.isArray(at) ? at.join(',') : at && [at.x, at.y, at.z].join(',');
        return `${r.title || r.name || r.label || r.id || ''}${p ? ` (${p})` : ''}`;
      }).filter(Boolean);
      lines.push(`${home.title || home.id}${rooms.length ? ': ' + rooms.join(' · ') : ''}`.slice(0, 700));
    }
    if (this.blocks.size) lines.push(`${t.kinds}: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    if (furnitureCount) {
      const heading = `${t.furnitureList}:`, rows = [];
      for (const f of furniture) {
        // Names come exclusively through the presentation callback, never raw
        // model/member ids; normalize and bound names to protect the prompt cap.
        const displayName = f.occupant === undefined ? [] : [...String(nameOf(f.occupant) ?? '').replace(/\s+/g, ' ').trim()];
        const name = displayName.length > 32 ? displayName.slice(0, 31).join('') + '…' : displayName.join('');
        const status = f.occupant === undefined ? t.furnitureFree : t.furnitureOccupied(name);
        const row = `- (${f.at}) ${f.shape}/${f.facing} · ${status}`;
        const reserve = t.furnitureMore(furnitureCount - rows.length - 1);
        if ([heading, ...rows, row, reserve].join('\n').length > MAX_FURNITURE_SUMMARY_CHARS) break;
        rows.push(row);
      }
      const omitted = furnitureCount - rows.length;
      lines.push([heading, ...rows, ...(omitted ? [t.furnitureMore(omitted)] : [])].join('\n'));
    }
    const signList = Object.entries(this.signs);
    if (signList.length) lines.push(`${t.signList}: ${signList.slice(0, 12).map(([k, s]) => `"${s.text}" (${k}, ${s.facing})`).join(', ')}${signList.length > 12 ? t.more(signList.length - 12) : ''}`);
    const custom = Object.entries(this.custom);
    if (custom.length) lines.push(`${t.custom}: ${custom.map(([n, c]) => `${n}(${nameOf(c.by)}${c.glow ? t.glow : ''}${c.clear ? t.clear : ''})`).join(', ')}`);
    lines.push(`${t.positions}: ${pos}`);
    const recent = this.log.slice(-8).map((l) => `- ${nameOf(l.by)}: ${l.text}`);
    if (recent.length) lines.push(`${t.recent}:\n${recent.join('\n')}`);
    return lines.join('\n');
  }

  // Text map for world_look: {y} gives that layer, otherwise a top view (top block letter
  // plus height). Optional region x1,z1,x2,z2.
  look(req = {}) {
    const r = typeof req === 'object' && req ? req : {};
    const x1 = clamp(int(r.x1 ?? 0), 0, SIZE.x - 1), x2 = clamp(int(r.x2 ?? SIZE.x - 1), 0, SIZE.x - 1);
    const z1 = clamp(int(r.z1 ?? 0), 0, SIZE.z - 1), z2 = clamp(int(r.z2 ?? SIZE.z - 1), 0, SIZE.z - 1);
    const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)];
    const t = tx();
    const legend = t.legend(NAMES.map((n) => `${LETTER[n]}=${n}`).join(' '));
    const letterOf = (v) => LETTER[parseBlock(v).type] ?? '*';
    const header = (w) => `     x→ ${Array.from({ length: w }, (_, i) => String((xa + i) % 10)).join('')}`;
    const rows = [];
    if (Number.isFinite(int(r.y))) {
      const y = clamp(int(r.y), 1, SIZE.y - 1);
      rows.push(t.layer(y, xa, xb, za, zb), legend, header(xb - xa + 1));
      for (let z = za; z <= zb; z++) {
        let s = '';
        for (let x = xa; x <= xb; x++) { const t = this.blocks.get(key(x, y, z)); s += t ? letterOf(t) : '.'; }
        rows.push(`z${String(z).padStart(2, '0')}  ${s}`);
      }
      return rows.join('\n');
    }
    rows.push(t.top(xa, xb, za, zb), legend, header(xb - xa + 1));
    for (let z = za; z <= zb; z++) {
      let s = '', h = '';
      for (let x = xa; x <= xb; x++) {
        const y = this.topY(x, z);
        s += y ? letterOf(this.blocks.get(key(x, y, z))) : '.';
        h += y ? y.toString(32) : '.';
      }
      rows.push(`z${String(z).padStart(2, '0')}  ${s}   ${h}`);
    }
    return rows.join('\n');
  }
}

function describeSpan(changes) {
  const lo = [0, 1, 2].map((i) => Math.min(...changes.map((c) => c[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...changes.map((c) => c[i])));
  return lo.join(',') === hi.join(',') ? `${lo.join(',')}` : `${lo.join(',')}~${hi.join(',')}`;
}
function clamp(v, a, b) { return Number.isNaN(v) ? a : Math.max(a, Math.min(b, v)); }
function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return dflt; throw error; }
}

// House metadata is public geometry/display data, never a generic config bag.
// Bound both its schema and size, including nested camera/room entries. Returned
// objects are fresh so a consumer cannot change the authoritative metadata.
function safeHome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const textFields = new Set(['id', 'title', 'name', 'label', 'shape', 'facing', 'room', 'roomId', 'kind', 'posture', 'fixtureVersion', 'rangeConvention', 'arrangement', 'archive']);
  const numberFields = new Set(['version', 'schemaVersion', 'floorY', 'roofY', 'wallTopY', 'roofTopY', 'x', 'y', 'z', 'x1', 'x2', 'z1', 'z2', 'minX', 'maxX', 'minZ', 'maxZ', 'width', 'height', 'depth', 'angle', 'elev', 'distance', 'dist', 'zoom', 'fov', 'yaw', 'pitch', 'tx', 'ty', 'tz', 'horizontalSpan', 'wallX']);
  const geometryFields = new Set(['at', 'center', 'position', 'target', 'lookAt', 'spawn', 'from', 'to', 'min', 'max', 'bounds', 'rect', 'rectXZ', 'entrance', 'entrances', 'approach', 'stairRoute', 'roofGroups', 'wallGroups', 'displaySlots', 'y', 'z']);
  let budget = 2048;
  const clean = (entry, depth = 0) => {
    if (--budget < 0 || depth > 5) return undefined;
    if (Array.isArray(entry)) return entry.slice(0, 64).map((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 10000 ? v : clean(v, depth + 1)).filter((v) => v !== undefined);
    if (!entry || typeof entry !== 'object') return undefined;
    const out = {};
    for (const [k, v] of Object.entries(entry)) {
      if (textFields.has(k) && typeof v === 'string') out[k] = v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
      else if (numberFields.has(k) && Number.isFinite(v) && Math.abs(v) <= 10000) out[k] = v;
      else if (k === 'hideGroups' && Array.isArray(v)) out[k] = v.slice(0, 64).filter((id) => typeof id === 'string' && /^[a-z0-9_-]{1,48}$/i.test(id));
      else if (geometryFields.has(k)) { const p = clean(v, depth + 1); if (p !== undefined) out[k] = p; }
    }
    return out;
  };
  const home = clean(Object.fromEntries(['id', 'title', 'version', 'schemaVersion', 'fixtureVersion', 'rangeConvention', 'floorY', 'roofY', 'wallTopY', 'roofTopY', 'bounds', 'rectXZ'].map((k) => [k, value[k]])));
  for (const k of ['rooms', 'cameras', 'cameraPresets', 'furniture', 'spawns', 'spawnPositions', 'entrances', 'routes', 'waterRegions', 'landmarks', 'commonRoomZones']) {
    const collection = value[k];
    if (Array.isArray(collection)) home[k] = collection.slice(0, 64).map((entry) => clean(entry)).filter(Boolean);
    else if (collection && typeof collection === 'object') home[k] = Object.fromEntries(Object.entries(collection).slice(0, 64)
      .filter(([id]) => /^[\p{L}\p{N}_-]{1,48}$/u.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id))
      .map(([id, entry]) => [id, clean(entry)]).filter(([, entry]) => entry !== undefined));
  }
  for (const k of ['cutaway', 'photoWall']) if (value[k] && typeof value[k] === 'object' && !Array.isArray(value[k])) home[k] = clean(value[k]);
  return Object.keys(home).length ? home : null;
}

function writeWorld(file, json) {
  const temp = `${file}.save-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  let fd, created = false;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve original error */ } }
    if (created) { try { fs.unlinkSync(temp); } catch { /* preserve original error */ } }
    throw error;
  }
}
