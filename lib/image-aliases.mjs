import fs from 'node:fs';
import path from 'node:path';

// Exact legacy image aliases only. No directory aliases or arbitrary targets.
const LEGACY = /^images\/(?:world-)?(?:gpt|claude|gemini|deepseek|grok|user)-\d{8}-\d{6}(?:-\d+)?\.(?:png|jpe?g|webp|gif)$/i;
const BRANDED = /^images\/ERCraft-\d{8}-\d{6}(?:-\d+)?\.(?:png|jpe?g|webp|gif)$/;
export function loadImageAliases(home) {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(home, 'data', 'image-aliases.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return new Map(); throw e; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid image aliases');
  const entries = Object.entries(value);
  for (const [oldPath, newPath] of entries) {
    if (!LEGACY.test(oldPath) || typeof newPath !== 'string' || !BRANDED.test(newPath)) throw new Error('Invalid image alias');
  }
  return new Map(entries);
}
