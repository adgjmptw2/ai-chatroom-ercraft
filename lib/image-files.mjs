import fs from 'node:fs';
import path from 'node:path';

// Preserve the local-time stamp used by room images. Exclusive writes/copies also
// reserve names across providers or processes; checking existence first is racy.
export function saveImageFile(directory, { source, data, extension = source ? path.extname(source) || '.png' : '.png', date = new Date() }) {
  if ((source !== undefined) === (data !== undefined)) throw new TypeError('Provide either image data or a source file');
  const ext = String(extension).toLowerCase();
  if (!/^\.(png|jpe?g|webp|gif)$/.test(ext)) throw new Error(`Unsupported image extension: ${ext}`);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${String(date.getFullYear()).padStart(4, '0')}${p2(date.getMonth() + 1)}${p2(date.getDate())}-${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
  fs.mkdirSync(directory, { recursive: true });
  for (let i = 1; ; i++) {
    const name = `ERCraft-${stamp}${i === 1 ? '' : `-${i}`}${ext}`;
    const destination = path.join(directory, name);
    try {
      if (source !== undefined) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      else fs.writeFileSync(destination, data, { flag: 'wx' });
      return name;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
