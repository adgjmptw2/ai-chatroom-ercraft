// Small, deterministic single-storey buildings. Recipes never contain raw world ops.
import { PALETTE, SIZE } from './world.mjs';

const SIDES = ['n', 'e', 's', 'w'];
const OPPOSITE = { n: 's', e: 'w', s: 'n', w: 'e' };
const MATERIALS = {
  foundation: ['stone', 'cobble', 'brick'],
  wall: ['white', 'stone', 'brick', 'planks'],
  trim: ['log', 'stone', 'cobble', 'brick', 'planks', 'black'],
  floor: ['planks', 'stone', 'brick'],
  roof: ['black', 'brick', 'stone', 'planks', 'red', 'cobble'],
  window: ['glass'],
  accent: ['red', 'purple', 'blue', 'gold', 'lamp', 'black'],
};

export const RECIPE_GUIDE = `Return one JSON recipe object, no markdown or raw operations. All fields required; unknown fields/options are errors:
{"kind":"house|pavilion|workshop|chapel","origin":[x,z],"size":[w,d],"wallHeight":3,"front":"n|e|s|w","materials":{"foundation":"stone","wall":"white","trim":"log","floor":"planks","roof":"black","window":"glass","accent":"purple"},"roof":{"type":"gable|hip|flat","ridge":"x|z","overhang":1},"windows":{"spacing":3,"height":1,"sill":1},"features":[]}
Integers only: origin is the main rectangle's northwest/minimum x,z corner; each size 7..11, wallHeight 3..5. World x,z 0..47, placed y 1..31. Single storey only, no towers or upper floors. Main foundation/floor y=1, walls y=2..wallHeight+1. Door is centered, two blocks high (double width on even facades); retain its clear approach. n is -z, e is +x. Windows share sill 1|2 (bottom y=2+sill), height 1|2, spacing 2|3|4, and require sill+height<=wallHeight-1 to keep the top beam. Pavilion uses open bays instead of glazing.
Material choices: ${Object.entries(MATERIALS).map(([k, v]) => `${k}=${v.join('|')}`).join('; ')}. Use restrained pale plaster/stone, dark timber and a dark or brick roof, with small accent details; no large castles.
Roof: overhang 0|1; gable ridge x|z; hip/flat require ridge=x (canonical unused value). Stair high sides always point uphill. Gable/hip are supported vaulted roofs, not another storey.
features: at most 2, each exactly {"type":"porch|garden|fountain|lamp_posts","side":"n|e|s|w","size":3}. One per side. Each occupies a centered 3x3 patch outside the main wall. Porch only on front, and its facade width must be odd; garden/fountain/lamp_posts only on non-front sides. Porch has a low canopy, garden a planter, fountain water at y=1 with a stone border and clear space above, lamp_posts two modest lights. No chimney/sign/text or other feature fields.
The complete building, eaves, features AND one-cell-deep front step must fit the supplied inclusive site [x1,z1,x2,z2], at most 14x14. Never shift, resize or clamp to fit. If no site is supplied the compiler derives that exact footprint. The returned bbox reserves the whole site, including interior air, from y=1 to the highest planned cell. Four deterministic stages: foundation, walls/open frame + windows/doors, roof, entrance/features. Every cell appears in exactly one stage, <=600 cells per stage and <=2000 total.`;

const fail = (message) => { throw new Error(`Recipe: ${message}`); };
const key = (x, y, z) => `${x},${y},${z}`;
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  if (Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k))
    || Object.keys(value).some((k) => !keys.includes(k))) fail(`${label} has missing or unsupported fields`);
}
function integer(value, lo, hi, label) {
  if (!Number.isSafeInteger(value) || value < lo || value > hi) fail(`${label} must be an integer ${lo}..${hi}`);
  return value;
}
function choice(value, values, label) {
  if (!values.includes(value)) fail(`unsupported ${label}`);
  return value;
}
function tuple(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || Object.keys(value).length !== length
    || Array.from({ length }, (_, i) => i).some((i) => !Object.hasOwn(value, i))) fail(`${label} must have ${length} entries`);
}
function siteOf(value) {
  tuple(value, 4, 'site');
  const [a, b, c, d] = value;
  value.forEach((v, i) => integer(v, 0, i % 2 ? SIZE.z - 1 : SIZE.x - 1, 'site coordinate'));
  if (a > c || b > d || c - a + 1 > 14 || d - b + 1 > 14) fail('site must be ordered and at most 14x14');
  return [...value];
}
function recipeOf(raw) {
  object(raw, ['kind', 'origin', 'size', 'wallHeight', 'front', 'materials', 'roof', 'windows', 'features'], 'recipe');
  choice(raw.kind, ['house', 'pavilion', 'workshop', 'chapel'], 'kind');
  tuple(raw.origin, 2, 'origin');
  raw.origin.forEach((v) => integer(v, 0, 47, 'origin'));
  tuple(raw.size, 2, 'size');
  raw.size.forEach((v) => integer(v, 7, 11, 'size'));
  integer(raw.wallHeight, 3, 5, 'wallHeight');
  choice(raw.front, SIDES, 'front');
  object(raw.materials, Object.keys(MATERIALS), 'materials');
  for (const [role, names] of Object.entries(MATERIALS)) choice(raw.materials[role], names, `${role} material`);
  object(raw.roof, ['type', 'ridge', 'overhang'], 'roof');
  choice(raw.roof.type, ['gable', 'hip', 'flat'], 'roof type');
  choice(raw.roof.ridge, ['x', 'z'], 'roof ridge');
  integer(raw.roof.overhang, 0, 1, 'roof overhang');
  if (raw.roof.type !== 'gable' && raw.roof.ridge !== 'x') fail('hip/flat roof requires ridge=x');
  object(raw.windows, ['spacing', 'height', 'sill'], 'windows');
  integer(raw.windows.spacing, 2, 4, 'window spacing');
  integer(raw.windows.height, 1, 2, 'window height');
  integer(raw.windows.sill, 1, 2, 'window sill');
  if (raw.windows.sill + raw.windows.height > raw.wallHeight - 1) fail('windows must leave a solid top beam');
  if (!Array.isArray(raw.features) || raw.features.length > 2 || Object.keys(raw.features).length !== raw.features.length) fail('features must contain at most 2 entries');
  const sides = new Set();
  for (const f of raw.features) {
    object(f, ['type', 'side', 'size'], 'feature');
    choice(f.type, ['porch', 'garden', 'fountain', 'lamp_posts'], 'feature type');
    choice(f.side, SIDES, 'feature side');
    integer(f.size, 3, 3, 'feature size');
    if (sides.has(f.side)) fail('only one feature per side');
    sides.add(f.side);
    if (f.type === 'porch') {
      if (f.side !== raw.front) fail('porch must be on the front');
      const width = raw.size[['n', 's'].includes(f.side) ? 0 : 1];
      if (width % 2 === 0) fail('porch needs an odd-width front facade');
    } else if (f.side === raw.front) fail('keep garden/fountain/lamp_posts off the entrance side');
  }
  // No references to caller-owned arrays or objects survive compilation.
  return JSON.parse(JSON.stringify(raw));
}

// Mirrored window axes with solid corner margins. A front's doorway and jambs
// remove both members of a mirrored pair together, preserving facade symmetry.
function windowAxes(length, spacing, front) {
  const center = (length - 1) / 2;
  const out = new Set();
  for (let a = 2; a <= center; a += spacing) {
    const b = length - 1 - a;
    if (a !== b && b - a < spacing) continue;
    if (front && Math.min(Math.abs(a - center), Math.abs(b - center)) < 2) continue;
    out.add(a); out.add(b);
  }
  return out;
}

export function compileRecipe(raw, { site } = {}) {
  const recipe = recipeOf(raw);
  const selected = site === undefined ? null : siteOf(site);
  const [x0, z0] = recipe.origin;
  const [w, d] = recipe.size;
  const x1 = x0 + w - 1, z1 = z0 + d - 1;
  const { materials: m, wallHeight: h, front, roof, windows, features, kind } = recipe;
  const top = h + 1, roofY = top + 1;
  const stages = ['Foundation and floor', kind === 'pavilion' ? 'Open frame and entrance' : 'Walls, windows and entrance', 'Roof and gables', 'Front step and details']
    .map((name) => ({ name, cells: [] }));
  const occupied = new Map();
  const put = (stage, x, y, z, block) => {
    if (![x, y, z].every(Number.isSafeInteger) || x < 0 || x >= SIZE.x || z < 0 || z >= SIZE.z || y < 1 || y >= SIZE.y) fail('building, entrance or features leave the world');
    const k = key(x, y, z);
    if (occupied.has(k)) {
      if (occupied.get(k)[3] !== block) fail('internal geometry collision');
      return;
    }
    const cell = [x, y, z, block];
    occupied.set(k, cell);
    stages[stage].cells.push(cell);
  };
  const lengthOf = (side) => ['n', 's'].includes(side) ? w : d;
  // offset=0 lies on a wall; positive offset projects outward.
  const sidePoint = (side, axis, offset = 0) => ({
    n: [x0 + axis, z0 - offset], s: [x0 + axis, z1 + offset],
    w: [x0 - offset, z0 + axis], e: [x1 + offset, z0 + axis],
  })[side];
  const doorAxes = new Set([Math.floor((lengthOf(front) - 1) / 2), Math.ceil((lengthOf(front) - 1) / 2)]);

  // One-cell plinth, flush interior floor; no inaccessible second storey.
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    put(0, x, 1, z, x === x0 || x === x1 || z === z0 || z === z1 ? m.foundation : m.floor);
  }
  for (const side of SIDES) {
    const length = lengthOf(side), axes = windowAxes(length, windows.spacing, side === front);
    for (let a = 0; a < length; a++) {
      const [x, z] = sidePoint(side, a);
      const corner = a === 0 || a === length - 1;
      const doorway = side === front && doorAxes.has(a);
      const jamb = side === front && [...doorAxes].some((v) => Math.abs(a - v) === 1) && !doorway;
      for (let y = 2; y <= top; y++) {
        let block;
        if (doorway && y <= 3) {
          if (kind === 'pavilion') continue;
          block = `door/${['n', 's'].includes(front) ? 'x' : 'z'}`;
        } else if (corner || jamb || y === top || doorway && y === 4) block = m.trim;
        else if (kind === 'pavilion') continue;
        else if (axes.has(a) && y >= 2 + windows.sill && y < 2 + windows.sill + windows.height) block = m.window;
        else if (axes.has(a) && y === 1 + windows.sill) block = m.trim;
        else block = m.wall;
        put(1, x, y, z, block);
      }
    }
  }

  const xa = x0 - roof.overhang, xb = x1 + roof.overhang;
  const za = z0 - roof.overhang, zb = z1 + roof.overhang;
  for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) {
    if (roof.type === 'flat') {
      put(2, x, roofY, z, `${m.roof}/slab`);
      continue;
    }
    const distances = { e: x - xa, w: xb - x, s: z - za, n: zb - z };
    const across = roof.ridge === 'z' ? ['e', 'w'] : ['s', 'n'];
    const slopes = roof.type === 'hip' ? ['e', 'w', 's', 'n'] : across;
    const rise = Math.min(...slopes.map((side) => distances[side]));
    const high = slopes.find((side) => distances[side] === rise);
    // A ridge cap where opposite pitches meet; hip diagonals choose a stable
    // uphill facing, never an outward stair.
    const ridge = slopes.includes(OPPOSITE[high]) && distances[high] === distances[OPPOSITE[high]];
    const y = roofY + rise;
    put(2, x, y, z, ridge ? `${m.roof}/slab` : `${m.roof}/stair/${high}`);
    // Bridge every diagonal step with a full underside voxel, so all roof
    // cells connect by faces (not just edges) back to the bearing walls.
    if (rise > 0) put(2, x, y - 1, z, m.roof);
    if (roof.type === 'gable' && kind !== 'pavilion') {
      const gable = roof.ridge === 'z' ? (z === z0 || z === z1) && x >= x0 && x <= x1
        : (x === x0 || x === x1) && z >= z0 && z <= z1;
      if (gable) for (let gy = roofY; gy < y - 1; gy++) put(2, x, gy, z, m.wall);
    }
  }

  // Always build a low walkable front step, even without optional features.
  const porch = features.find((f) => f.type === 'porch');
  if (!porch) for (const a of doorAxes) {
    const [x, z] = sidePoint(front, a, 1);
    put(3, x, 1, z, `${m.foundation}/stair/${OPPOSITE[front]}`);
  }
  for (const f of features) {
    const start = Math.floor((lengthOf(f.side) - 3) / 2);
    for (let a = 0; a < 3; a++) for (let depth = 1; depth <= 3; depth++) {
      const [x, z] = sidePoint(f.side, start + a, depth);
      const center = a === 1 && depth === 2;
      let block = m.foundation;
      if (f.type === 'porch') block = depth === 3 ? `${m.foundation}/stair/${OPPOSITE[front]}` : m.floor;
      if (f.type === 'garden' && center) block = 'dirt';
      if (f.type === 'fountain' && center) block = 'water';
      put(3, x, 1, z, block);
      if (f.type === 'garden' && center) put(3, x, 2, z, 'leaves');
      if (f.type === 'lamp_posts' && a !== 1 && depth === 2) {
        put(3, x, 2, z, m.trim);
        put(3, x, 3, z, 'lamp');
      }
      if (f.type === 'porch') {
        if (a !== 1 && depth === 3) for (let y = 2; y <= 3; y++) put(3, x, y, z, m.trim);
        put(3, x, 4, z, `${m.roof}/slab`);
      }
    }
  }
  // Restrained detail at ground level, away from the protected entrance.
  // The workshop gets a workbench, the chapel a small altar, and a house a
  // side table. All have ground contact and leave the door-to-center path open.
  if (kind !== 'pavilion') {
    const [x, z] = sidePoint(OPPOSITE[front], 1, -1);
    put(3, x, 2, z, kind === 'chapel' ? m.trim : `${m.trim}/slab`);
    if (kind === 'chapel') put(3, x, 3, z, m.accent);
    if (kind === 'workshop') {
      const [bx, bz] = sidePoint(OPPOSITE[front], 2, -1);
      put(3, bx, 2, bz, `${m.trim}/slab`);
    }
  }

  const all = [...occupied.values()];
  const extent = [Math.min(...all.map((c) => c[0])), Math.min(...all.map((c) => c[2])),
    Math.max(...all.map((c) => c[0])), Math.max(...all.map((c) => c[2]))];
  const reserved = selected ?? siteOf(extent);
  if (extent[0] < reserved[0] || extent[1] < reserved[1] || extent[2] > reserved[2] || extent[3] > reserved[3]) fail('building, entrance, eaves and features must fit the site');
  const bbox = [reserved[0], 1, reserved[1], reserved[2], Math.max(...all.map((c) => c[1])), reserved[3]];
  if (all.length > 2000 || stages.some((s) => s.cells.length < 1 || s.cells.length > 600)) fail('plan exceeds cell budget');
  for (const stage of stages) stage.cells.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  return { recipe, stages, bbox, count: all.length };
}

// Validate stored/untrusted compiled plans by canonical recompilation. This
// checks geometry, doors, phase partition and reserved air, not merely bounds.
export function validateCompiled(compiled) {
  object(compiled, ['recipe', 'stages', 'bbox', 'count'], 'compiled plan');
  tuple(compiled.bbox, 6, 'bbox');
  compiled.bbox.forEach((n) => integer(n, 0, 47, 'bbox coordinate'));
  integer(compiled.count, 1, 2000, 'compiled count');
  tuple(compiled.stages, 4, 'compiled stages');
  const b = compiled.bbox;
  const expected = compileRecipe(compiled.recipe, { site: [b[0], b[2], b[3], b[5]] });
  if (compiled.count !== expected.count || b.some((n, i) => n !== expected.bbox[i])) fail('compiled bounds/count mismatch');
  compiled.stages.forEach((stage, i) => {
    object(stage, ['name', 'cells'], 'stage');
    const want = expected.stages[i];
    if (stage.name !== want.name || !Array.isArray(stage.cells) || stage.cells.length !== want.cells.length) fail('compiled stage mismatch');
    for (let j = 0; j < stage.cells.length; j++) {
      const cell = stage.cells[j];
      tuple(cell, 4, 'cell');
      if (cell.some((n, k) => n !== want.cells[j][k])) fail('compiled cell mismatch');
      if (!Object.hasOwn(PALETTE, cell[3].split('/')[0])) fail('unknown compiled material');
    }
  });
  return true;
}
