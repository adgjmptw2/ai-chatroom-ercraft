import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Static, smooth Mulgyeol Maru dollhouse. World coordinates are deliberately
 * unchanged: cell centres are x/z + .5; the finished floor/standing feet are y=3.
 * No scene lights, animation, textures, requests, or world mutations are owned
 * here. The host owns lighting, camera, avatars, photos and invalidation.
 *
 * All parts are baked into one mesh per (visibility layer, material). The
 * three visibility layers keep the rear/album walls in the cutaway. Stats
 * count visible source parts as visibleInstances, even though they are merged.
 */
export function createDiorama({ THREE, home, blocks }) {
  if (!THREE || !home || home.id !== 'mulgyeol-maru') {
    throw new TypeError('createDiorama requires THREE and the Mulgyeol Maru home');
  }
  const group = new THREE.Group();
  group.name = 'mulgyeol-maru-diorama';
  const layers = {};
  for (const name of ['interior', 'foreground', 'roof']) {
    layers[name] = new THREE.Group();
    layers[name].name = `diorama-${name}`;
    group.add(layers[name]);
  }
  const colors = {
    cream: 0xeadfca, ivory: 0xfff4df, oak: 0xb98a59, wood: 0x785d46,
    brass: 0xc5a16b, teal: 0x587f78, sage: 0x9fb49a, butter: 0xe5c879,
    rose: 0xd69eaa, lavender: 0xaaa6c5, leaf: 0x4d7960, leafLight: 0x83a87d,
    soil: 0x5f5848, pot: 0xbc8063, stone: 0xa49f8f, sand: 0xd9cbae,
    sea: 0x639fa8, shallows: 0x8cbfc0, foam: 0xc8e0d7, slate: 0x526f75,
    ink: 0x344e58, shade: 0xb6aa92, glow: 0xffd799,
  };
  const materials = new Map(), buckets = new Map(), cache = new Map();
  const objects = [], openings = [], frames = [];
  let layer = 'interior', subject = null, disposed = false, cutaway = true;
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
  const axisY = new THREE.Vector3(0, 1, 0);
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const readBlock = (x, y, z) => blocks instanceof Map
    ? blocks.get(`${x},${y},${z}`) : blocks?.[`${x},${y},${z}`];
  const entries = blocks instanceof Map ? [...blocks] : Object.entries(blocks || {});
  const consumed = new Set();
  const matches = id => {
    const f = home.furniture[id];
    const [, shape, facing] = f ? String(readBlock(...f.at) || '').split('/') : [];
    return f && shape === f.shape && (shape === 'chair' || !facing || facing === f.facing);
  };
  const idsWith = prefix => Object.keys(home.furniture).filter(id => id.startsWith(prefix));
  const sourceGroups = {
    'living-sofa': idsWith('sofa-'), 'dining-table': idsWith('dining-table-'),
    'album-table': idsWith('album-table-'), 'album-bench': idsWith('album-bench-'),
    'courtyard-bench': idsWith('courtyard-bench-'),
  };
  const blockGroups = {
    'kitchen-south': Array.from({ length: 6 }, (_, i) => [31 + i, 4, 36]),
    'kitchen-east': Array.from({ length: 5 }, (_, i) => [36, 4, 31 + i]),
    'album-library': Array.from({ length: 4 }, (_, i) => [36, 4, 21 + i]),
    'courtyard-tree': [[19, 4, 21]], 'bedside-lamp': [[10, 4, 10], [10, 5, 10]],
    'bath-vanity': [[10, 4, 21]],
  };
  function material(color) {
    if (!materials.has(color)) {
      const m = new THREE.MeshLambertMaterial({ color: colors[color] });
      m.name = `diorama-${color}`;
      if (color === 'glow') { m.emissive.setHex(colors.glow); m.emissiveIntensity = .35; }
      materials.set(color, m);
    }
    return materials.get(color);
  }
  function cached(key, make) {
    if (!cache.has(key)) {
      const g = make();
      g.deleteAttribute('uv');
      g.clearGroups();
      cache.set(key, g);
    }
    return cache.get(key);
  }
  function emit(source, color, x, y, z, sx = 1, sy = 1, sz = 1, turn = 0, tilt = 0) {
    const g = source.clone();
    rotation.setFromEuler(new THREE.Euler(tilt, turn, 0, 'YXZ'));
    matrix.compose(v(x, y, z), rotation, v(sx, sy, sz));
    g.applyMatrix4(matrix);
    // Common position/normal-only, non-indexed format for every primitive.
    const geometry = g.index ? g.toNonIndexed() : g;
    if (geometry !== g) g.dispose();
    geometry.deleteAttribute('uv');
    const key = `${layer}:${color}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(geometry);
    if (subject) {
      geometry.computeBoundingBox();
      subject.bounds.union(geometry.boundingBox);
    }
  }
  function object(id, fn) {
    const ids = sourceGroups[id] || (home.furniture[id] ? [id] : []);
    if (ids.some(key => !matches(key))) return;
    const cells = blockGroups[id] || [];
    if (cells.some(at => {
      const value = String(readBlock(...at) || '');
      if (id === 'album-library') return value !== 'bookshelf';
      if (id === 'courtyard-tree') return value !== 'casa_pot';
      if (id.startsWith('kitchen-')) return !/^casa_(tile\/workbench\/|cream$)/.test(value);
      return !value;
    })) return;
    for (const key of ids) consumed.add(home.furniture[key].at.join(','));
    for (const at of cells) consumed.add(at.join(','));
    const previous = subject;
    subject = { id, bounds: new THREE.Box3() };
    fn();
    objects.push({ id, min: subject.bounds.min.toArray(), max: subject.bounds.max.toArray() });
    subject = previous;
  }
  function inLayer(name, fn) { const previous = layer; layer = name; fn(); layer = previous; }
  const cube = () => cached('cube', () => new THREE.BoxGeometry(1, 1, 1));
  function box(x, y, z, w, h, d, c, turn = 0, tilt = 0) {
    emit(cube(), c, x, y, z, w, h, d, turn, tilt);
  }
  // Six rounded faces, with analytic normals. One segment per half-fillet;
  // broad faces stay genuinely planar instead of becoming inflated spheres.
  function roundedGeometry(w, h, d, radius) {
    const r = Math.min(radius, w / 2 - .001, h / 2 - .001, d / 2 - .001);
    return cached(`round:${w},${h},${d},${r}`, () => {
      const half = [w / 2, h / 2, d / 2], inner = half.map(n => n - r);
      const positions = [], normals = [], indices = [];
      const grid = n => [-n, -n + r, n - r, n];
      for (const [a, b, c, sign] of [[0, 1, 2, 1], [0, 2, 1, -1], [1, 2, 0, 1], [1, 0, 2, -1], [2, 0, 1, 1], [2, 1, 0, -1]]) {
        const base = positions.length / 3, us = grid(half[b]), vs = grid(half[c]);
        for (const vv of vs) for (const uu of us) {
          const p = [0, 0, 0]; p[a] = sign * half[a]; p[b] = uu; p[c] = vv;
          const q = p.map((n, i) => Math.max(-inner[i], Math.min(inner[i], n)));
          const normal = v(p[0] - q[0], p[1] - q[1], p[2] - q[2]).normalize();
          positions.push(q[0] + normal.x * r, q[1] + normal.y * r, q[2] + normal.z * r);
          normals.push(normal.x, normal.y, normal.z);
        }
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
          const k = base + j * 4 + i;
          indices.push(k, k + 1, k + 5, k, k + 5, k + 4);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      g.setIndex(indices);
      return g;
    });
  }
  function round(x, y, z, w, h, d, r, c, turn = 0, tilt = 0) {
    // Sub-pixel edge radii on inlays, books and flat textiles need no fillets.
    if (r < .035) return box(x, y, z, w, h, d, c, turn, tilt);
    emit(roundedGeometry(w, h, d, r), c, x, y, z, 1, 1, 1, turn, tilt);
  }
  function sphere(x, y, z, sx, sy, sz, c, turn = 0, tilt = 0) {
    const small = Math.max(sx, sy, sz) < .3;
    const g = cached(`sphere:${small}`, () => new THREE.SphereGeometry(1, small ? 6 : 8, small ? 4 : 6));
    emit(g, c, x, y, z, sx, sy, sz, turn, tilt);
  }
  function cylinder(x, y, z, top, bottom, h, c, turn = 0, tilt = 0, segments = 12) {
    const g = cached(`cylinder:${top},${bottom},${h},${segments}`, () => new THREE.CylinderGeometry(top, bottom, h, segments));
    emit(g, c, x, y, z, 1, 1, 1, turn, tilt);
  }
  function rod(a, b, radius, color, endRadius = radius) {
    const av = v(...a), bv = v(...b), delta = bv.clone().sub(av);
    const g = new THREE.CylinderGeometry(endRadius, radius, delta.length(), 6);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(axisY, delta.normalize()));
    g.deleteAttribute('uv');
    const p = av.add(bv).multiplyScalar(.5);
    emit(g, color, p.x, p.y, p.z); g.dispose();
  }
  function torus(x, y, z, r, tube, c, turn = 0, tilt = Math.PI / 2, arc = Math.PI * 2) {
    const g = cached(`torus:${r},${tube},${arc}`, () => new THREE.TorusGeometry(r, tube, 4, 12, arc));
    emit(g, c, x, y, z, 1, 1, 1, turn, tilt);
  }
  const anchor = id => {
    const f = home.furniture[id];
    if (!f) throw new Error(`Diorama furniture missing: ${id}`);
    return [f.at[0] + .5, f.at[1] - 1, f.at[2] + .5];
  };
  function feet(x, z, w, d, top, c = 'wood', turn = 0) {
    for (const xx of [-1, 1]) for (const zz of [-1, 1]) {
      const p = v(xx * w / 2, 0, zz * d / 2).applyAxisAngle(axisY, turn);
      rod([x + p.x * 1.08, 3.04, z + p.z * 1.08], [x + p.x, top, z + p.z], .044, c, .035);
    }
  }
  function rug(x, z, w, d, accent, pattern = 'border') {
    round(x, 3.018, z, w, .025, d, .011, accent);
    round(x, 3.034, z, w - .18, .008, d - .18, .003, 'ivory');
    round(x, 3.04, z, w - .29, .008, d - .29, .003, accent);
    if (pattern === 'flower') {
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        sphere(x + Math.sin(angle) * .27, 3.05, z + Math.cos(angle) * .27, .105, .006, .24, 'ivory', angle);
      }
      cylinder(x, 3.052, z, .12, .12, .008, 'butter');
    } else {
      for (let j = -1; j <= 1; j++) {
        round(x, 3.05, z + j * d * .24, w * .68, .009, .036, .003, 'ivory');
      }
    }
    // A restrained fringe, rendered with actual geometry, never a pixel map.
    for (let i = 0; i < Math.floor(w * 5); i++) for (const side of [-1, 1]) {
      box(x - w / 2 + .12 + i * .2, 3.022, z + side * (d / 2 + .045), .022, .012, .1, 'ivory');
    }
  }
  function plant(x, y, z, scale = 1, flowers = false) {
    cylinder(x, y + .2 * scale, z, .22 * scale, .15 * scale, .4 * scale, 'pot');
    torus(x, y + .39 * scale, z, .208 * scale, .025 * scale, 'pot');
    cylinder(x, y + .39 * scale, z, .188 * scale, .188 * scale, .018 * scale, 'soil');
    for (let i = 0; i < 7; i++) {
      const a = i * 2.399, reach = (.16 + (i % 3) * .055) * scale;
      const dx = Math.sin(a) * reach, dz = Math.cos(a) * reach, height = (.64 + (i % 3) * .13) * scale;
      rod([x, y + .38 * scale, z], [x + dx, y + height, z + dz], .012 * scale, 'leaf');
      sphere(x + dx, y + height, z + dz, .1 * scale, .23 * scale, .055 * scale, i % 2 ? 'leafLight' : 'leaf', a, .55);
      if (flowers && i % 2 === 0) {
        for (let p = 0; p < 5; p++) sphere(x + dx + Math.sin(p * 1.257) * .065 * scale, y + height + .12 * scale,
          z + dz + Math.cos(p * 1.257) * .065 * scale, .065 * scale, .035 * scale, .065 * scale, 'ivory');
        sphere(x + dx, y + height + .135 * scale, z + dz, .032 * scale, .027 * scale, .032 * scale, 'butter');
      }
    }
  }
  function cup(x, y, z, c = 'ivory') {
    cylinder(x, y + .07, z, .065, .05, .14, c, 0, 0, 12);
    cylinder(x, y + .144, z, .052, .052, .005, 'wood', 0, 0, 12);
    torus(x + .065, y + .077, z, .043, .014, c, 0, 0);
  }
  function book(x, y, z, w, d, c, turn = 0) {
    round(x, y + .055, z, w, .09, d, .02, 'ivory', turn);
    round(x, y + .105, z, w + .025, .022, d + .025, .01, c, turn);
    box(x, y + .008, z, w + .02, .016, d + .02, c, turn);
  }
  function lamp(x, y, z, scale = 1) {
    cylinder(x, y + .035, z, .17 * scale, .19 * scale, .07, 'brass');
    rod([x, y, z], [x, y + .52 * scale, z], .022 * scale, 'brass');
    cylinder(x, y + .57 * scale, z, .17 * scale, .29 * scale, .34 * scale, 'ivory');
    cylinder(x, y + .401 * scale, z, .24 * scale, .24 * scale, .008, 'glow');
    sphere(x, y + .758 * scale, z, .03, .034, .03, 'brass');
  }

  // Continuous sculpted shoreline; no voxel terrain, tile maps or wave timer.
  round(24, -.33, 26, 53, .44, 55, .2, 'sea');
  const shore = new THREE.Shape();
  shore.moveTo(3, 5); shore.bezierCurveTo(15, 2, 32, 3, 38, 6);
  shore.bezierCurveTo(40, 13, 39.6, 20, 40.5, 28);
  shore.bezierCurveTo(40.2, 34, 42, 39, 38, 43);
  shore.bezierCurveTo(29, 44, 23, 42.2, 15, 43.5);
  shore.bezierCurveTo(8, 43.5, 3, 40, 3, 32); shore.closePath();
  const land = new THREE.ExtrudeGeometry(shore, { depth: .35, bevelEnabled: true, bevelSize: .35, bevelThickness: .25, bevelSegments: 2, curveSegments: 16, steps: 1 });
  land.rotateX(Math.PI / 2); land.deleteAttribute('uv'); land.clearGroups();
  emit(land, 'sand', 0, 0, 0); land.dispose();
  // Keep static crests to the sea side of the shore and off both stair routes.
  for (let i = 0; i < 24; i++) {
    const x = i < 12 ? 42 + (i % 3) * 2.5 : 9 + (i - 12) * 3.25;
    const z = i < 12 ? 10 + i * 3 : 46 + i % 2 * 2;
    round(x, -.093, z, 1.1 + i % 3 * .45, .016, .07, .007, i % 3 ? 'shallows' : 'foam', -.2 + i % 3 * .15);
    if (i % 3 === 0) round(x + .4, -.091, z + .21, .62, .012, .035, .005, 'foam', -.2);
  }
  for (let i = 0; i < 31; i++) {
    const east = i < 16;
    const x = east ? 39.5 + Math.sin(i * 1.8) * .3 : 9 + (i - 16) * 2.02;
    const z = east ? 9 + i * 2.04 : 42.1 + Math.cos(i * 1.9) * .35;
    sphere(x, .05, z, .48 + i % 3 * .19, .36 + i % 2 * .13, .48 + i % 4 * .12, i % 3 ? 'stone' : 'shade', i * .91);
    if (i % 4 === 0) sphere(x - .34, .17, z + .1, .3, .26, .34, 'sage');
  }
  // Rounded plinth and three precisely aligned physical steps at each door.
  round(23.5, 1.25, 23.5, 29.15, 2.5, 29.15, .22, 'stone');
  round(23.5, 2.65, 23.5, 29.3, .36, 29.3, .12, 'sand');
  box(23.5, 2.91, 23.5, 29, .14, 29, 'oak');
  for (let i = 1; i <= 3; i++) {
    round(21.5, i / 2, 41.5 - i, 3, i, 1, .055, 'cream');
    box(21.5, i - .065, 42 - i - .035, 2.98, .06, .05, 'sand');
    round(5.5 + i, i / 2, 27.5, 1, i, 3, .055, 'cream');
  }
  // Floor finish is continuous, with a single border rather than cell tiles.
  box(23.5, 2.99, 33.5, 27, .02, 7, 'cream');
  round(23.5, 3.001, 23, 11, .012, 6, .005, 'stone');
  round(23.5, 3.012, 23, 10.55, .016, 5.55, .007, 'sand');
  box(12, 3.008, 23, 4, .015, 4, 'slate');
  rug(15, 33.6, 6, 4.65, 'sage');
  rug(26.5, 33, 5.8, 4.6, 'sand');
  rug(21.5, 35.2, 1.65, 2.8, 'sage');
  rug(34.3, 23.1, 3.8, 4.5, 'lavender');
  rug(23.4, 23.6, 5.8, 2.45, 'cream');
  // Fine timber border/inlay around the open galleries.
  for (const [x, z, w, d] of [[23.5, 19.87, 27, .06], [23.5, 26.13, 27, .06], [17.86, 23, .06, 6], [29.14, 23, .06, 6]]) {
    box(x, 3.013, z, w, .014, d, 'wood');
  }

  // Wall profiles are made from contiguous source runs, not rendered cells.
  // Read actual holes/windows in blocks so the thin shell matches collision.
  function wallLine(axis, fixedCell, start, end, fixedPhysical, retained = false) {
    const cell = (u, y) => axis === 'x' ? readBlock(u, y, fixedCell) : readBlock(fixedCell, y, u);
    function kind(u) {
      const low = cell(u, 4), mid = cell(u, 5);
      if ((!low && !mid) || String(low).startsWith('door/')) return 'door';
      if (String(mid).split('/')[0] === 'glass') return 'window';
      return 'wall';
    }
    const signature = u => `${kind(u)}:${[4, 5, 6, 7].map(y => {
      const value = String(cell(u, y) || '');
      return !value || value.startsWith('door/') ? '0' : value === 'glass' ? 'g' : '1';
    }).join('')}`;
    const place = (u, y, length, height, depth, c, offset = 0) => axis === 'x'
      ? box(u, y, fixedPhysical + offset, length, height, depth, c)
      : box(fixedPhysical + offset, y, u, depth, height, length, c);
    function panel(a, b, bottom, top, c = 'cream', thickness = .24) {
      if (top <= bottom) return;
      place((a + b) / 2, (bottom + top) / 2, b - a, top - bottom, thickness, c);
    }
    let a = start;
    while (a < end) {
      const type = kind(a); let b = a + 1;
      while (b < end && signature(b) === signature(a)) b++;
      const upper = retained ? 'interior' : 'foreground';
      if (type === 'wall') {
        // Coalesce vertically as well: deleting even one wall cell produces
        // a real hole, while untouched walls remain long continuous panels.
        let y = 4;
        while (y < 8) {
          if (!cell(a, y)) { y++; continue; }
          const bottom = y - 1;
          while (y < 8 && cell(a, y)) y++;
          const top = y - 1;
          if (retained) panel(a, b, bottom, top);
          else {
            panel(a, b, bottom, Math.min(top, 3.65));
            inLayer(upper, () => panel(a, b, Math.max(bottom, 3.65), top));
          }
        }
        if (cell(a, 4)) {
          place((a + b) / 2, 3.08, b - a, .16, .29, 'ivory');
          if (!retained) place((a + b) / 2, 3.655, b - a, .045, .28, 'ivory');
        }
      } else if (type === 'window') {
        panel(a, b, 3, retained ? 4.12 : 3.65);
        if (!retained) inLayer(upper, () => panel(a, b, 3.65, 4.12));
        inLayer(upper, () => {
          panel(a, b, 6, 7);
          place((a + b) / 2, 5.07, b - a - .12, 1.78, .035, 'shallows');
          for (const h of [4.13, 6.02]) place((a + b) / 2, h, b - a + .08, .12, .34, 'ivory');
          for (const u of [a + .04, b - .04]) place(u, 5.08, .1, 1.92, .32, 'teal');
          for (let u = a + 1; u < b - .1; u += 1) place(u, 5.08, .05, 1.82, .12, 'ivory');
          place((a + b) / 2, 5.08, b - a, .048, .12, 'ivory');
          place((a + b) / 2, 4.1, b - a + .26, .105, .48, 'oak');
          // Gathered linen curtains. Each fold is a softly rounded strip.
          for (const edge of [a + .16, b - .16]) for (let f = 0; f < 3; f++) {
            const u = edge + (f - 1) * .065;
            const offset = (fixedCell === 9 ? .22 : -.22) + Math.sin(f * 1.7) * .045;
            if (axis === 'x') round(u, 5.02, fixedPhysical + offset, .11, 2.02, .095, .045, 'ivory');
            else round(fixedPhysical + offset, 5.02, u, .095, 2.02, .11, .045, 'ivory');
          }
          place((a + b) / 2, 6.15, b - a + .42, .045, .08, 'brass');
        });
        openings.push({ kind: type, axis, fixed: fixedPhysical, start: a, end: b, bottom: 4.12, top: 6 });
      } else {
        let openingTop = 7;
        for (let y = 4; y <= 7; y++) {
          const value = String(cell(a, y) || '');
          if (value && !value.startsWith('door/')) { openingTop = y - 1; break; }
        }
        inLayer(upper, () => {
          if (openingTop < 7) {
            panel(a, b, openingTop + .12, 7);
            place((a + b) / 2, openingTop + .06, b - a + .15, .12, .31, 'oak');
          }
          for (const edge of [a - .035, b + .035]) place(edge, (3 + openingTop) / 2, .065, openingTop - 3, .29, 'ivory');
        });
        openings.push({ kind: type, axis, fixed: fixedPhysical, start: a, end: b, bottom: 3, top: openingTop });
      }
      if (cell(a, 7)) inLayer(upper, () => place((a + b) / 2, 6.93, b - a, .14, .3, 'teal'));
      a = b;
    }
  }
  wallLine('x', 9, 9, 38, 9.84, true);
  wallLine('x', 37, 9, 38, 37.16);
  wallLine('z', 9, 10, 37, 9.84);
  wallLine('z', 37, 10, 20, 37.16);
  wallLine('z', 37, 20, 26, 37.16, true);
  wallLine('z', 37, 26, 37, 37.16);
  wallLine('x', 16, 10, 37, 16.5);
  wallLine('x', 29, 10, 37, 29.5);
  for (const x of [16, 23, 30]) wallLine('z', x, 10, 16, x + .5);
  wallLine('x', 20, 10, 15, 20.5);
  wallLine('x', 25, 10, 15, 25.5);
  wallLine('z', 14, 21, 25, 14.5);

  // Timber portico keeps exactly the four already blocked courtyard posts.
  for (const [x, z] of [[18.5, 20.5], [28.5, 20.5], [18.5, 25.5], [28.5, 25.5]]) {
    cylinder(x, 3.12, z, .2, .23, .24, 'stone');
    cylinder(x, 4.95, z, .095, .13, 3.7, 'oak');
    round(x, 6.78, z, .33, .18, .33, .055, 'wood');
    inLayer('roof', () => {
      rod([x, 6.1, z], [x + (x < 23 ? .68 : -.68), 6.94, z], .055, 'oak');
    });
  }
  inLayer('roof', () => {
    for (const z of [20.5, 25.5]) box(23.5, 6.96, z, 10.55, .21, .22, 'oak');
  });

  // Four rooms share a furniture vocabulary, with distinct woven textiles.
  function chair(id, accent) {
    const [x, y, z] = anchor(id), f = home.furniture[id];
    const facing = String(readBlock(...f.at) || '').split('/')[2] || f.facing;
    const turn = ({ s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 })[facing] || 0;
    object(id, () => {
      feet(x, z, .48, .48, y + .5, 'wood', turn);
      round(x, y + .48, z, .72, .12, .73, .055, 'oak', turn);
      round(x, y + .575, z, .7, .17, .66, .08, accent, turn);
      const back = v(0, 0, -.31).applyAxisAngle(axisY, turn);
      round(x + back.x, y + .98, z + back.z, .74, .73, .16, .079, accent, turn, -.09);
      // A curved shell silhouette, with tiny brass feet and soft back piping.
      const rail = v(0, 0, -.405).applyAxisAngle(axisY, turn);
      round(x + rail.x, y + 1.12, z + rail.z, .57, .055, .055, .025, 'ivory', turn);
    });
  }
  function desk(id) {
    const [x, y, z] = anchor(id);
    object(id, () => {
      feet(x, z, .74, .53, y + .87);
      round(x, y + .9, z, .94, .14, .83, .065, 'oak');
      round(x, y + .69, z + .02, .77, .21, .57, .04, 'wood');
      box(x, y + .7, z + .32, .69, .16, .045, 'oak');
      sphere(x, y + .7, z + .354, .025, .025, .018, 'brass');
      book(x - .17, y + .98, z - .03, .32, .4, 'teal', .09);
      cup(x + .28, y + .98, z + .1);
    });
  }
  const bedroomColors = ['sage', 'butter', 'rose', 'lavender'];
  home.rooms.filter(r => r.kind === 'bedroom').forEach((room, index) => {
    const accent = bedroomColors[index % 4], x0 = room.rectXZ[0];
    // Large visual warmth comes from rugs, not oversized blocking mattresses.
    rug(x0 + 2.65, 13.2, 4.9, 4.7, accent, 'flower');
    const id = `${room.id}-bed`, [x, y, z] = anchor(id);
    object(id, () => {
      feet(x, z - .3, .85, 1.33, y + .28);
      round(x, y + .29, z - .3, 1.19, .24, 1.62, .08, 'oak');
      round(x, y + .47, z - .3, 1.14, .25, 1.61, .12, 'ivory');
      round(x, y + .84, z - 1.08, 1.3, 1.35, .13, .062, 'oak');
      round(x, y + .91, z - .99, 1.12, .88, .12, .056, accent);
      // A softly lofted duvet with a turned-down linen edge and hanging foot.
      round(x, y + .615, z - .06, 1.17, .19, 1.04, .09, accent);
      round(x, y + .715, z - .48, 1.15, .09, .24, .042, 'ivory');
      round(x, y + .49, z + .43, 1.17, .32, .12, .058, accent);
      for (const side of [-1, 1]) round(x + side * .29, y + .68, z - .8, .51, .18, .37, .088, 'ivory', side * .055);
      for (let stripe = -2; stripe <= 2; stripe++) box(x + stripe * .16, y + .713, z + .22, .033, .008, .33, 'ivory');
    });
    desk(`${room.id}-desk`);
    chair(`${room.id}-chair`, accent);
    // Rear-wall shelves/art are above head height and outside desk approaches.
    box(x0 + .9, 5.62, 10.04, 1.2, 1.03, .085, 'oak');
    box(x0 + .9, 5.62, 10.094, 1.03, .85, .04, 'ivory');
    sphere(x0 + .78, 5.7, 10.124, .27, .2, .01, accent);
    sphere(x0 + 1.12, 5.43, 10.13, .16, .12, .012, 'sage');
    box(x0 + 4.75, 5.92, 10.2, 1.65, .09, .44, 'oak');
    for (let b = 0; b < 4; b++) box(x0 + 4.28 + b * .11, 6.14 + b % 2 * .035, 10.19, .082, .34 + b % 2 * .07, .22,
      [accent, 'ivory', 'teal', 'pot'][b]);
    plant(x0 + 5.25, 5.97, 10.18, .48);
    // Tiny table lights sit on occupied/rear corners, never in walking cells.
    if (index === 0) object('bedside-lamp', () => {
      round(10.5, 3.37, 10.5, .69, .72, .68, .06, 'oak'); lamp(10.5, 3.73, 10.5, .8);
    });
    if (index === 3) { book(36.48, 3.02, 10.48, .45, .51, 'lavender'); }
  });

  // Living room: one continuous four-seat sofa following the four bench cells.
  const sofaCells = Object.keys(home.furniture).filter(id => /^sofa-/.test(id)).map(anchor);
  if (sofaCells.length) {
    const x = sofaCells[0][0], z0 = Math.min(...sofaCells.map(p => p[2])) - .45;
    const z1 = Math.max(...sofaCells.map(p => p[2])) + .45, z = (z0 + z1) / 2;
    object('living-sofa', () => {
      for (const zz of [z0 + .2, z1 - .2]) for (const xx of [x - .27, x + .27]) cylinder(xx, 3.16, zz, .045, .055, .3, 'wood');
      round(x, 3.38, z, .94, .45, z1 - z0, .15, 'sage');
      round(x - .32, 3.94, z, .25, 1.17, z1 - z0 - .1, .12, 'sage');
      for (const p of sofaCells) {
        round(x + .08, 3.63, p[2], .72, .22, .82, .105, 'ivory');
        round(x - .2, 4.03, p[2], .26, .67, .83, .12, 'ivory');
      }
      for (const zz of [z0 + .12, z1 - .12]) round(x + .02, 3.85, zz, .93, .64, .24, .11, 'sage');
      round(x + .07, 3.95, z0 + .65, .29, .49, .46, .14, 'butter', .11);
      round(x + .07, 3.96, z1 - .68, .29, .48, .48, .14, 'teal', -.14);
      // Removable throws are drawn by living-view from committed blanket state.
    });
  }
  object('living-table', () => {
    const [x, y, z] = anchor('living-table');
    cylinder(x, y + .37, z, .17, .28, .69, 'oak');
    emit(cached('tabletop', () => new THREE.CylinderGeometry(1, 1, .12, 32)), 'oak', x, y + .74, z, .46, 1, .7);
    book(x - .08, y + .8, z + .2, .36, .43, 'teal', -.2);
    cylinder(x + .02, y + .815, z - .21, .2, .2, .025, 'brass');
    plant(x + .02, y + .83, z - .21, .42, true);
  });
  object('dining-table', () => {
    const cells = Object.keys(home.furniture).filter(id => id.startsWith('dining-table-')).map(anchor);
    const x = cells.reduce((s, p) => s + p[0], 0) / cells.length, z = cells.reduce((s, p) => s + p[2], 0) / cells.length;
    feet(x, z, 2.24, 1.21, 3.87);
    round(x, 3.93, z, 2.88, .16, 1.83, .079, 'oak');
    round(x, 4.018, z, .48, .015, 1.75, .007, 'ivory');
    // Dining plates and cups belong to living-view's state-driven table setting.
    // Static duplicates would remain visible after table_clear.
    plant(x, 4.025, z, .48, true);
  });
  for (const id of Object.keys(home.furniture).filter(id => id.startsWith('dining-chair-'))) chair(id, 'butter');

  // Teal shaker cabinets with rounded stone counters, a recessed basin,
  // curved brass tap, ceramic plates and a restrained open shelf.
  object('kitchen-south', () => {
    round(34, 3.46, 36.51, 5.94, .87, .88, .055, 'teal');
    box(34, 3.1, 36.08, 5.66, .14, .03, 'wood');
    round(34, 3.95, 36.5, 6, .13, .97, .055, 'ivory');
    for (let x = 31.5; x < 37; x++) {
      round(x, 3.55, 36.055, .82, .63, .045, .02, 'sage');
      box(x, 3.55, 36.025, .7, .5, .025, 'teal');
      rod([x - .1, 3.78, 35.996], [x + .1, 3.78, 35.996], .017, 'brass');
    }
    // Two nested cooker rings, no texture tiles.
    round(35.55, 4.023, 36.5, .94, .025, .69, .012, 'ink');
    for (const x of [35.29, 35.81]) for (const z of [36.32, 36.68]) torus(x, 4.044, z, .105, .015, 'stone');
    cylinder(35.31, 4.12, 36.34, .12, .115, .15, 'pot');
    sphere(35.31, 4.225, 36.34, .13, .045, .13, 'pot');
    cylinder(35.31, 4.269, 36.34, .025, .025, .032, 'wood');
    round(32.38, 4.035, 36.48, .55, .028, .56, .013, 'oak', .08);
    sphere(32.31, 4.12, 36.5, .095, .09, .095, 'butter');
    sphere(32.46, 4.12, 36.46, .085, .085, .085, 'rose');
    plant(31.37, 4.02, 36.52, .52);
  });
  object('kitchen-east', () => {
    round(36.54, 3.46, 33.48, .87, .87, 4.94, .055, 'teal');
    round(36.53, 3.96, 32.15, .94, .13, 2.27, .055, 'ivory');
    round(36.53, 3.96, 34.65, .94, .13, 2.57, .055, 'ivory');
    // Sink opening is a dark bowl below the worktop, not a box on top of it.
    round(36.54, 3.86, 33.33, .65, .055, .76, .025, 'slate');
    for (const x of [36.12, 36.94]) box(x, 3.96, 33.32, .09, .13, .77, 'ivory');
    torus(36.82, 4.22, 33.32, .16, .021, 'brass', Math.PI / 2, 0, Math.PI);
    rod([36.82, 4.03, 33.48], [36.82, 4.22, 33.48], .021, 'brass');
    for (let z = 31.5; z < 36; z++) {
      round(36.086, 3.53, z, .045, .63, .81, .02, 'sage');
      box(36.055, 3.53, z, .023, .5, .69, 'teal');
      rod([36.026, 3.76, z - .09], [36.026, 3.76, z + .09], .017, 'brass');
    }
    cup(36.55, 4.04, 31.62, 'butter');
    cylinder(36.51, 4.17, 35.42, .12, .1, .28, 'pot');
    for (const off of [-.04, .04]) rod([36.51, 4.26, 35.42 + off], [36.48 + off, 4.52, 35.42 + off], .019, 'oak');
  });
  inLayer('foreground', () => {
    box(34.1, 5.69, 36.9, 3.55, .12, .38, 'oak');
    for (let i = 0; i < 4; i++) cylinder(33.1 + i * .28, 5.87, 36.88, .085, .075, .24, i % 2 ? 'ivory' : 'pot');
    plant(35.37, 5.76, 36.84, .45);
  });
  inLayer('roof', () => {
    round(36.25, 6.25, 36.35, .94, .22, .82, .07, 'ivory');
    box(36.25, 6.66, 36.35, .46, .68, .46, 'ivory');
  });

  // Courtyard camellia grows only over the already occupied planter corner.
  object('courtyard-tree', () => {
    cylinder(19.48, 3.31, 21.38, .44, .34, .61, 'pot', 0, 0, 24);
    torus(19.48, 3.61, 21.38, .423, .05, 'pot');
    cylinder(19.48, 3.615, 21.38, .375, .375, .023, 'soil');
    rod([19.48, 3.64, 21.38], [19.35, 5.27, 21.28], .105, 'wood', .045);
    for (let i = 0; i < 8; i++) {
      const a = i * 2.4, x = 19.28 + Math.sin(a) * .49, z = 21.06 + Math.cos(a) * .49, y = 5.08 + i % 3 * .29;
      rod([19.38, 4.55, 21.3], [x, y, z], .033, 'wood', .014);
      sphere(x, y, z, .48, .39, .48, i % 3 ? 'leaf' : 'leafLight', a);
      if (i % 2 === 0) for (let p = 0; p < 5; p++) sphere(x + Math.sin(p * 1.257) * .075, y + .31,
        z + Math.cos(p * 1.257) * .075, .082, .041, .082, 'rose');
    }
  });
  object('courtyard-bench', () => {
    feet(26, 21.5, 3.42, .52, 3.49);
    round(26, 3.53, 21.5, 3.91, .13, .79, .062, 'oak');
    for (const x of [24.28, 27.72]) rod([x, 3.36, 21.18], [x, 4.16, 21.18], .042, 'wood');
    round(26, 3.97, 21.19, 3.85, .28, .11, .052, 'oak');
    for (const x of [25, 26, 27]) round(x, 3.64, 21.52, .87, .1, .64, .046, 'sage');
  });

  // Low library credenza leaves the six west-facing photo planes unobscured.
  object('album-library', () => {
    box(36.63, 3.45, 23, .62, .87, 3.93, 'wood');
    for (const y of [3.08, 3.48, 3.89]) round(36.57, y, 23, .78, .08, 4, .035, 'oak');
    for (const z of [21.03, 22, 23, 24, 24.96]) box(36.54, 3.48, z, .68, .79, .05, 'oak');
    for (let j = 0; j < 4; j++) for (let b = 0; b < 5; b++) {
      const z = 21.18 + j + b * .145, h = .22 + b % 3 * .035;
      box(36.48, 3.16 + h / 2, z, .38, h, .105, ['sage', 'ivory', 'rose', 'teal', 'butter'][b]);
      box(36.274, 3.21, z, .017, .019, .09, 'brass');
    }
    for (let b = 0; b < 3; b++) box(36.47, 3.565 + b * .06, 24.4, .39, .048, .53, ['lavender', 'ivory', 'teal'][b]);
  });
  for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
    if (String(readBlock(37, 6 - row, 21 + col) || '').split('/')[0] !== 'casa_album') continue;
    const x = 36.995, y = 5.5 - row, z = 21.5 + col;
    // Photo: .70 x .92. Opening: .72 x .94. Frame front faces west
    // at x=36.91, with no backing geometry in front of the parent's photo.
    const fw = .84, fh = 1.04, bar = .045;
    for (const side of [-1, 1]) {
      round(36.969, y + side * (fh / 2 - bar / 2), z, .095, bar, fw, .018, 'oak');
      round(36.969, y, z + side * (fw / 2 - bar / 2), .095, fh - bar * 2, bar, .018, 'oak');
    }
    box(37.012, y, z, .018, .94, .72, 'ivory');
    // Empty slots get a tiny embossed botanical silhouette behind the image.
    // Loaded photos at x=36.995 cover it without z fighting.
    sphere(37.001, y, z, .003, .12, .1, col === 1 ? 'rose' : 'sage');
    frames.push({ position: [x, y, z], facing: 'w', opening: [.72, .94] });
  }
  object('album-table', () => {
    const a = anchor('album-table-33'), b = anchor('album-table-34'), x = (a[0] + b[0]) / 2, z = a[2];
    feet(x, z, 1.4, .51, 3.79);
    round(x, 3.84, z, 1.88, .13, .88, .064, 'oak');
    book(x - .28, 3.911, z, .59, .49, 'lavender', -.08);
    cup(x + .54, 3.92, z + .06);
  });
  object('album-bench', () => {
    feet(34.5, 24.5, 2.38, .52, 3.46);
    round(34.5, 3.47, 24.5, 2.87, .14, .83, .065, 'oak');
    round(34.5, 3.6, 24.5, 2.83, .2, .78, .099, 'lavender');
    round(34.5, 3.98, 24.8, 2.83, .67, .15, .07, 'lavender');
    for (const x of [33.7, 35.3]) round(x, 3.97, 24.64, .47, .41, .2, .099, 'ivory');
  });
  object('maintenance-console', () => {
    const [x, y, z] = anchor('maintenance-console');
    feet(x, z, .51, .62, y + .85);
    round(x, y + .9, z, .86, .13, .93, .063, 'oak');
    round(x + .17, y + 1.2, z, .06, .48, .58, .029, 'ink');
    box(x + .132, y + 1.2, z, .014, .38, .48, 'shallows');
    round(x - .14, y + .982, z, .32, .026, .45, .012, 'slate');
  });
  // No album lamps in front of photos. The reading lamp is at the far end.
  if (readBlock(36, 4, 24) === 'bookshelf') lamp(36.53, 3.94, 24.62, .65);

  object('laundry', () => {
    const [x, y, z] = anchor('laundry');
    round(x, y + .46, z, .83, .89, .85, .075, 'ivory');
    torus(x + .431, y + .46, z, .244, .045, 'stone', Math.PI / 2, 0);
    sphere(x + .441, y + .46, z, .008, .2, .2, 'slate');
    sphere(x + .458, y + .77, z + .2, .018, .043, .043, 'teal');
    round(x, y + .965, z, .86, .09, .88, .04, 'oak');
    for (let i = 0; i < 3; i++) round(x, y + 1.04 + i * .07, z, .56, .07, .39, .033, i % 2 ? 'ivory' : 'sage');
  });
  chair('bath-stool', 'teal');
  object('bath-vanity', () => {
    round(10.5, 3.39, 21.5, .84, .73, .82, .06, 'oak');
    cylinder(10.5, 3.85, 21.5, .37, .29, .22, 'ivory');
    cylinder(10.5, 3.96, 21.5, .29, .29, .012, 'shallows');
    rod([10.5, 3.94, 21.17], [10.5, 4.2, 21.17], .022, 'brass');
    rod([10.5, 4.2, 21.17], [10.5, 4.2, 21.31], .022, 'brass');
  });
  inLayer('foreground', () => {
    round(10.58, 4.95, 20.66, .99, 1.21, .1, .049, 'oak');
    round(10.58, 4.95, 20.72, .86, 1.08, .025, .012, 'shallows');
  });

  // Geometry edits retain free agency: the bespoke grouped models above are
  // used only while their real source cells exist. Moved/new furniture and
  // incomplete groups get individual smooth models at their actual cells.
  function structural(x, y, z, type) {
    const inside = x >= 9 && x < 38 && z >= 9 && z < 38;
    if (inside && y <= 3) return true;
    if (inside && y >= 8 && y <= 9 && ['casa_roof', 'casa_oak'].includes(type)) return true;
    if (inside && y >= 4 && y <= 7 && (x === 9 || x === 37 || z === 9 || z === 37 ||
      z === 16 || z === 29 || [16, 23, 30].includes(x) && z < 16 ||
      [20, 25].includes(z) && x < 15 || x === 14 && z >= 21 && z < 25)) return true;
    if (y <= 3 && (x >= 20 && x < 23 && z >= 38 && z < 41 || x >= 6 && x < 9 && z >= 26 && z < 29)) return true;
    if (y <= 1 && ['water', 'sand'].includes(type)) return true;
    if (y >= 4 && y <= 7 && ((x === 18 || x === 28) && (z === 20 || z === 25)) && type === 'casa_oak') return true;
    if (y === 7 && x >= 18 && x <= 28 && (z === 20 || z === 25) && type === 'casa_oak') return true;
    return false;
  }
  const representedDecor = new Set(['19,5,21', '18,5,21', '19,5,20', '19,6,21', '36,5,25',
    '36,6,36', '12,7,33', '28,7,35', '35,7,23', '36,4,10']);
  function looseFurniture(key, value) {
    const [cx, cy, cz] = key.split(',').map(Number), [type, shape = 'full', facing = 's'] = value.split('/');
    const x = cx + .5, y = cy - 1, z = cz + .5;
    const turn = ({ s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 })[facing] || 0;
    const color = ({ casa_sage: 'sage', casa_butter: 'butter', casa_rose: 'rose', casa_lavender: 'lavender',
      casa_frame: 'teal', casa_tile: 'ivory', casa_cream: 'cream', casa_pot: 'pot',
      stone: 'stone', sand: 'sand', glass: 'shallows', leaves: 'leaf', water: 'sea' })[type] || 'oak';
    object(`block:${key}`, () => {
      if (shape === 'chair' || shape === 'bench') {
        for (const xx of [-.28, .28]) for (const zz of [-.28, .28]) cylinder(x + xx, y + .23, z + zz, .038, .046, .46, 'wood');
        round(x, y + .51, z, .86, .21, .84, .1, color, turn);
        const back = v(0, 0, -.35).applyAxisAngle(axisY, turn);
        round(x + back.x, y + .89, z + back.z, .86, .64, .13, .063, color, turn);
      } else if (shape === 'bed') {
        round(x, y + .24, z, .91, .3, .94, .07, 'oak', turn);
        round(x, y + .48, z, .9, .24, .93, .11, 'ivory', turn);
        round(x, y + .61, z, .91, .13, .55, .063, color, turn);
        const p = v(0, 0, -.31).applyAxisAngle(axisY, turn);
        round(x + p.x, y + .65, z + p.z, .66, .17, .24, .08, 'ivory', turn);
      } else if (shape === 'table' || shape === 'workbench') {
        cylinder(x, y + .41, z, .15, .26, .81, 'wood');
        round(x, y + .9, z, .93, .14, .93, .065, shape === 'workbench' ? 'ivory' : color);
      } else if (type === 'bookshelf') {
        box(x + .31, y + .45, z, .16, .9, .9, 'wood');
        for (const yy of [.08, .47, .91]) box(x, y + yy, z, .86, .065, .95, 'oak');
        for (let b = 0; b < 5; b++) box(x, y + .27, z - .32 + b * .15, .5, .28, .105, ['sage', 'rose', 'ivory', 'teal', 'butter'][b]);
      } else if (type === 'leaves') {
        sphere(x, y + .48, z, .48, .48, .48, 'leaf');
      } else if (type === 'lamp') {
        lamp(x, y, z, .7);
      } else if (shape === 'slab' || type === 'water') {
        round(x, y + .24, z, .99, .48, .99, .055, color);
      } else if (shape === 'stair') {
        box(x, y + .24, z, .99, .48, .99, color);
        const p = v(0, 0, -.25).applyAxisAngle(axisY, turn);
        box(x + p.x, y + .74, z + p.z, .99, .5, .49, color, turn);
      } else if (shape === 'door') {
        box(x, y + .5, z, .09, 1, .98, 'oak', turn);
      } else {
        round(x, y + .5, z, .98, .98, .98, .06, color);
      }
    });
  }
  for (const [key, raw] of entries) {
    if (consumed.has(key) || representedDecor.has(key)) continue;
    const value = String(raw), [x, y, z] = key.split(',').map(Number), type = value.split('/')[0];
    if (![x, y, z].every(Number.isFinite) || structural(x, y, z, type)) continue;
    looseFurniture(key, value);
  }

  // Low coastal grasses occupy only perimeter landscaping, not the stairways.
  for (const [x, z, s] of [[7.2, 11, 1.3], [7.1, 18, 1.2], [7.4, 33, 1.5], [11, 40.3, 1.2], [16.8, 40.2, 1.15], [26, 40.4, 1.1], [33.8, 40.5, 1.3], [39, 16, .8], [39, 33, .85]]) {
    plant(x, .12, z, s, true);
    sphere(x + .4, .18, z - .21, .42, .22, .31, 'stone');
  }

  // Proper pitched standing-seam roofs, with an open central courtyard.
  // Their ridges stay at home.roofY; eaves meet the y=7 architecture.
  function roofPanel(rect, pitched, acrossX = false) {
    const [x0, z0, x1, z1] = rect, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const width = x1 - x0 + .5, depth = z1 - z0 + .5;
    if (!pitched) {
      round(cx, 7.25, cz, width, .19, depth, .085, 'teal');
      box(cx, 7.08, cz, width - .05, .13, depth - .05, 'oak');
      return;
    }
    const run = (acrossX ? width : depth) / 2, rise = .86, angle = Math.atan2(rise, run), length = Math.hypot(run, rise);
    for (const side of [-1, 1]) {
      if (acrossX) {
        const g = new THREE.BoxGeometry(length, .16, depth); g.rotateZ(-side * angle);
        emit(g, 'teal', cx + side * run / 2, 7.5, cz); g.dispose();
      } else box(cx, 7.5, cz + side * run / 2, width, .16, length, 'teal', 0, side * angle);
    }
    if (acrossX) {
      round(cx, 7.97, cz, .16, .16, depth + .04, .075, 'slate');
      for (let z = z0; z < z1 + .2; z += 1.6) for (const s of [-1, 1]) rod([cx, 8, z], [cx + s * run, 7.14, z], .025, 'slate');
      for (const s of [-1, 1]) box(cx + s * run, 7.09, cz, .16, .17, depth, 'ivory');
    } else {
      round(cx, 7.97, cz, width + .04, .16, .16, .075, 'slate');
      for (let x = x0; x < x1 + .2; x += 1.6) for (const s of [-1, 1]) rod([x, 8, cz], [x, 7.14, cz + s * run], .025, 'slate');
      for (const s of [-1, 1]) box(cx, 7.09, cz + s * run, width, .17, .16, 'ivory');
    }
  }
  inLayer('roof', () => {
    for (const r of home.cutaway.roofGroups) {
      const pitched = !r.id.includes('gallery');
      roofPanel(r.rectXZ, pitched, ['bath-roof', 'album-roof'].includes(r.id));
    }
  });

  // One merged draw per material/layer; no groups, multipass surfaces or maps.
  for (const [key, parts] of buckets) {
    const [name, color] = key.split(':');
    const geometry = mergeGeometries(parts, false);
    if (!geometry) throw new Error(`Unable to merge diorama material ${key}`);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material(color));
    mesh.name = key; mesh.userData.sourceParts = parts.length;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    layers[name].add(mesh);
    for (const part of parts) part.dispose();
  }
  buckets.clear();
  for (const g of cache.values()) g.dispose();
  cache.clear();
  // Small, inspectable metadata for route/album regression checks, not state.
  group.userData.diorama = { floorY: 3, furniture: objects, openings, photoFrames: frames };
  function setCutaway(value) {
    if (disposed) return;
    cutaway = Boolean(value);
    layers.foreground.visible = !cutaway;
    layers.roof.visible = !cutaway;
  }
  function setNight(value) {
    if (disposed) return;
    const m = materials.get('glow');
    if (m) m.emissiveIntensity = value ? .85 : .35;
  }
  function stats() {
    let meshes = 0, triangles = 0, visibleInstances = 0, totalMeshes = 0, totalTriangles = 0;
    if (!disposed) {
      group.traverse(node => { if (node.isMesh) {
        totalMeshes++;
        totalTriangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
      } });
      group.traverseVisible(node => { if (node.isMesh) {
        meshes++;
        triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
        visibleInstances += node.userData.sourceParts;
      } });
    }
    return { meshes, triangles, visibleInstances, totalMeshes, totalTriangles, materials: disposed ? 0 : materials.size, cutaway };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    group.traverse(node => { if (node.isMesh) node.geometry.dispose(); });
    for (const m of materials.values()) m.dispose();
    materials.clear();
    group.removeFromParent(); group.clear();
  }
  setCutaway(true);
  return { group, setCutaway, setNight, dispose, stats };
}
