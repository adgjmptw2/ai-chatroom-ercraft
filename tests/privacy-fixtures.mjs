import { deflateSync } from 'node:zlib';

export function pngChunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit=0;bit<8;bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size,body,sum]);
}
export function tinyPng(metadata = []) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1,0); header.writeUInt32BE(1,4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),
    ...metadata, pngChunk('IDAT',deflateSync(Buffer.from([0,120,130,140,128]))),pngChunk('IEND')]);
}
