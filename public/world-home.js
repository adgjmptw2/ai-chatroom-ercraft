// Camera and visibility rules are client-only. They never mutate the world.
export const HOME_CAMERAS = Object.freeze({
  overview: { position: [46, 52, 70], target: [23.5, 2.6, 24], fov: 35 },
  living: { position: [30, 21, 53], target: [23, 3.5, 33], fov: 51 },
  courtyard: { position: [29, 23, 41], target: [23.5, 3.5, 22], fov: 46 },
  album: { position: [26, 9, 24], target: [35.5, 4.6, 23], fov: 51 },
});
export const NEIGHBORS = Object.freeze([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]);
export function homeVisible(x, y, z, home, cutaway = true, cut = Infinity) {
  if (y > cut) return false;
  if (!cutaway || home?.id !== 'mulgyeol-maru') return true;
  if (x < 9 || x >= 38 || z < 9 || z >= 38) return true;
  if (y >= 8) return false;
  if (x === 36 && y === 6 && z === 36) return false; // ceiling-mounted hood in cutaway
  // Keep the rear walls and the album wall; lower foreground walls/partitions.
  const foregroundWall = x === 9 && z !== 9 || z === 37 || z === 16 || z === 29
    || [16,23,30].includes(x) && z >= 10 && z < 16
    || x === 37 && !(z >= 20 && z < 26) && z !== 9
    || x === 14 && z >= 20 && z < 26 || [20,25].includes(z) && x >= 10 && x < 15;
  if (y >= 5 && foregroundWall) return false;
  return true;
}
export function opaqueCube(value, custom = {}) {
  if (!value) return false;
  const [type, shape = 'full'] = value.split('/');
  return shape === 'full' && !['glass', 'water', 'door'].includes(type) && !custom[type]?.clear;
}
export function buriedCube(x, y, z, value, blocks, custom, visible) {
  if (!opaqueCube(value, custom)) return false;
  return NEIGHBORS.every(([dx,dy,dz]) => visible(x+dx,y+dy,z+dz)
    && (y+dy === 0 && x+dx >= 0 && x+dx < 48 && z+dz >= 0 && z+dz < 48
      || opaqueCube(blocks.get(`${x+dx},${y+dy},${z+dz}`), custom)));
}
export function safeRoute(path) {
  if (!Array.isArray(path) || path.length > 2304) return [];
  return path.filter(p => p && [p.x,p.y,p.z].every(Number.isFinite)
    && p.x >= 0 && p.x < 48 && p.z >= 0 && p.z < 48 && p.y >= 0 && p.y <= 33);
}
