// Shared, data-only furniture dimensions: one occupied cell, north is -z.
// Boxes are [width, height, depth, centerX, centerY, centerZ, shade], measured
// from the cell floor. Shading is baked into vertices, never extra materials.
const legs = (x, z, h) => [-x, x].flatMap((px) => [-z, z].map((pz) => [0.1, h, 0.1, px, h / 2, pz, 0.72]));
export const FURNITURE = Object.freeze({
  chair: { posture: 'sit', surface: 0.46, height: 0.98, boxes: [
    ...legs(0.27, 0.25, 0.4), [0.72, 0.12, 0.68, 0, 0.4, 0, 1],
    [0.09, 0.58, 0.1, -0.27, 0.69, 0.25, 0.83], [0.09, 0.58, 0.1, 0.27, 0.69, 0.25, 0.83],
    [0.64, 0.17, 0.09, 0, 0.88, 0.25, 1], [0.64, 0.12, 0.09, 0, 0.66, 0.25, 0.92],
  ] },
  table: { posture: 'work', surface: 0.8, height: 0.8, boxes: [
    ...legs(0.33, 0.33, 0.68), [0.94, 0.12, 0.94, 0, 0.74, 0, 1],
    [0.72, 0.12, 0.7, 0, 0.62, 0, 0.8],
  ] },
  bench: { posture: 'sit', surface: 0.44, height: 0.9, boxes: [
    [0.14, 0.38, 0.5, -0.34, 0.19, 0, 0.72], [0.14, 0.38, 0.5, 0.34, 0.19, 0, 0.72],
    [0.94, 0.11, 0.27, 0, 0.385, -0.15, 1], [0.94, 0.11, 0.27, 0, 0.385, 0.15, 0.96],
    [0.08, 0.5, 0.09, -0.35, 0.65, 0.28, 0.8], [0.08, 0.5, 0.09, 0.35, 0.65, 0.28, 0.8],
    [0.94, 0.18, 0.08, 0, 0.8, 0.28, 1],
  ] },
  bed: { posture: 'lie', surface: 0.49, height: 0.7, boxes: [
    ...legs(0.32, 0.4, 0.22), [0.86, 0.12, 0.98, 0, 0.25, 0, 0.72],
    [0.8, 0.15, 0.86, 0, 0.385, 0, 1.14], [0.68, 0.06, 0.25, 0, 0.49, 0.26, 1.35],
    [0.82, 0.025, 0.52, 0, 0.4725, -0.16, 0.82], [0.88, 0.5, 0.07, 0, 0.45, 0.455, 0.9],
  ] },
  workbench: { posture: 'work', surface: 0.8, height: 0.95, boxes: [
    ...legs(0.34, 0.3, 0.69), [0.96, 0.12, 0.84, 0, 0.74, 0, 1],
    [0.76, 0.07, 0.62, 0, 0.22, 0, 0.77], [0.75, 0.18, 0.55, 0, 0.59, 0, 0.82],
    [0.17, 0.07, 0.05, 0, 0.6, -0.295, 0.5], // drawer pull
    [0.12, 0.24, 0.2, -0.27, 0.75, -0.39, 0.58], // vise
    [0.68, 0.15, 0.06, 0.08, 0.875, 0.36, 0.9], // tool rail
  ] },
});
export const FURNITURE_SHAPES = Object.freeze(Object.keys(FURNITURE));
export const FACING_VECTOR = Object.freeze({ n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] });
export const FACING_TURN = Object.freeze({ n: 0, e: -Math.PI / 2, s: Math.PI, w: Math.PI / 2 });
export const isFurniture = (shape) => Object.hasOwn(FURNITURE, shape);
// All facings share one geometry and one draw call; instance matrices rotate it.
export const furnitureBatch = (type, shape) => `${type}/${shape}`;

export function furnitureGeometry(THREE, mergeGeometries, shape) {
  const pieces = FURNITURE[shape].boxes.map(([w, h, d, x, y, z, shade]) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y - 0.5, z);
    const c = new Float32Array(g.attributes.position.count * 3);
    c.fill(shade);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.clearGroups();
    return g;
  });
  const merged = mergeGeometries(pieces, false);
  for (const g of pieces) g.dispose();
  merged.clearGroups();
  return merged;
}

// Stable hash/noise: no random state, network assets, normal maps, or per-frame work.
const hash = (x, y, seed) => {
  let v = Math.imul(x + seed * 31, 374761393) ^ Math.imul(y + seed, 668265263);
  v = Math.imul(v ^ v >>> 13, 1274126177);
  return ((v ^ v >>> 16) >>> 0) / 4294967295;
};
const seedOf = (name) => [...name].reduce((a, c) => Math.imul(a, 31) + c.charCodeAt(0) | 0, 7);
export const materialSize = (name) => ['brick', 'planks', 'log', 'bookshelf', 'door'].includes(name) ? 64 : 32;

// Draw once into a small cached canvas. The palette remains the color authority.
export function drawMaterial(g, size, name, hex) {
  const seed = seedOf(name), rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const color = (shade, warmth = 0) => `rgb(${rgb.map((v, i) => Math.max(0, Math.min(255, Math.round(v * shade + warmth * [1, 0.3, -0.4][i])))).join(',')})`;
  const rect = (x, y, w, h, shade, warmth = 0) => { g.fillStyle = color(shade, warmth); g.fillRect(x, y, w, h); };
  const wood = (y0 = 0, height = size) => {
    for (let y = y0; y < y0 + height; y++) for (let x = 0; x < size; x++) {
      const row = Math.floor((y - y0) / 16), line = (y - y0) % 16;
      const grain = Math.sin(x * 0.19 + Math.sin(y * 0.6) * 2) * 0.024;
      const joint = (x + row * 23) % 48 === 0;
      const shade = line === 0 || joint ? 0.69 : line === 1 ? 1.12 : 0.96 + grain + hash(x, y, seed) * 0.09;
      rect(x, y, 1, 1, shade, row % 2 ? 2 : -2);
    }
    for (let y = y0 + 7; y < y0 + height; y += 16) {
      const x = (y * 7 + 13) % (size - 9);
      rect(x, y, 7, 1, 0.83); rect(x + 2, y + 1, 3, 1, 0.75);
    }
  };
  if (['planks', 'door', 'bookshelf'].includes(name)) wood();
  else for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = hash(x, y, seed), broad = hash(x >> 2, y >> 2, seed);
    let shade = 0.97 + (n - 0.5) * 0.07;
    if (name === 'brick' || name === 'stone' || name === 'cobble') {
      const h = name === 'brick' ? 16 : name === 'stone' ? 16 : 8;
      const w = name === 'brick' ? 32 : name === 'stone' ? 32 : 16;
      const row = Math.floor(y / h), xx = (x + (row % 2) * w / 2) % w, yy = y % h;
      const tile = hash(Math.floor((x + (row % 2) * w / 2) / w), row, seed);
      shade = xx === 0 || yy === 0 ? (name === 'brick' ? 0.62 : 0.7)
        : xx === 1 || yy === 1 ? 1.15 : xx === w - 1 || yy === h - 1 ? 0.84
          : 0.9 + tile * 0.12 + (n - 0.5) * 0.08;
    } else if (name === 'log') {
      const stripe = (x + Math.round(Math.sin(y / 11) * 2)) % 13;
      shade = stripe < 2 ? 0.65 : stripe < 4 ? 1.17 : 0.88 + n * 0.2;
    } else if (name === 'grass' || name === 'leaves') {
      shade = 0.82 + broad * 0.25 + n * 0.14;
      if (name === 'leaves' && (x + y * 3) % 7 === 0) shade *= 0.75;
    } else if (name === 'dirt' || name === 'sand') {
      shade = 0.92 + n * 0.14 + (broad - 0.5) * 0.08;
      if (n > 0.94) shade *= 0.79;
    } else if (name === 'water') {
      shade = 0.93 + Math.sin(x * 0.5 + Math.sin(y * 0.4)) * 0.04;
      if ((y + Math.round(Math.sin(x * 0.22) * 2)) % 11 === 0) shade = 1.16;
    } else if (name === 'gold') {
      shade = x === 0 || y === 0 ? 0.68 : x === 1 || y === 1 ? 1.15 : 0.95 + n * 0.04;
    } else if (name === 'glass') {
      shade = x < 1 || y < 1 || x === size - 1 || y === size - 1 ? 0.78 : Math.abs(x - y) < 2 ? 1.1 : 1;
    } else { // painted plaster / snow: fine mineral speckle and gentle clouding
      shade += (broad - 0.5) * 0.045;
      if (n > 0.99) shade -= 0.09;
    }
    rect(x, y, 1, 1, shade);
  }
  if (name === 'door') {
    rect(2, 2, size - 4, 2, 0.67); rect(2, size - 4, size - 4, 2, 0.67);
    rect(2, 2, 2, size - 4, 0.67); rect(size - 4, 2, 2, size - 4, 0.67);
    rect(7, 8, size - 14, 1, 1.15); rect(7, 32, size - 14, 2, 0.72);
    g.fillStyle = '#cbb16b'; g.fillRect(51, 31, 5, 4);
  }
  if (name === 'bookshelf') {
    // Lower half: spines; upper half: wood (top/bottom UVs select that half).
    const colors = ['#87626e', '#587c80', '#536d52', '#c4a661', '#97624a', '#6d7190'];
    rect(3, 2, size - 6, 27, 0.45);
    for (let x = 5, i = 0; x < size - 5; x += 6, i++) {
      const h = 17 + (i % 3) * 2;
      g.fillStyle = colors[i % colors.length]; g.fillRect(x, 28 - h, 5, h);
      g.fillStyle = '#d6c49a'; g.fillRect(x + 1, 31 - h, 3, 1); g.fillRect(x + 1, 24, 3, 1);
      g.fillStyle = '#ffffff24'; g.fillRect(x, 28 - h, 1, h);
    }
    rect(0, 29, size, 3, 0.72);
  }
}
