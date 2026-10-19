// Streaming JSONL replay. Memory is bounded by the requested window plus one
// record (a single JSON record necessarily has to fit in memory), never the log.
import fs from 'node:fs';

export const MAX_RECENT_MESSAGES = 2000;
export const MAX_HISTORY_PAGE = 200;
export const HISTORY_CHUNK_BYTES = 64 * 1024;

const validId = (id) => Number.isSafeInteger(id) && id > 0;
export const isOverlay = (record) => record.kind === 'react' || record.kind === 'desc';

class RecordReader {
  constructor(visit) {
    this.visit = visit;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.offset = 0;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.info = { byteLength: 0, needsNewline: false, invalidRecords: 0, firstInvalidOffset: null, incompleteTail: false };
  }

  write(chunk) {
    this.info.byteLength += chunk.length;
    this.info.needsNewline = chunk.at(-1) !== 10;
    let start = 0;
    for (let end; (end = chunk.indexOf(10, start)) !== -1; start = end + 1) {
      this.line(chunk.subarray(start, end), true);
    }
    if (start < chunk.length) {
      // The sync scanner reuses its read buffer; retain only a copy of the tail.
      const tail = Buffer.from(chunk.subarray(start));
      this.fragments.push(tail);
      this.fragmentBytes += tail.length;
    }
  }

  invalid(incomplete) {
    this.info.invalidRecords++;
    this.info.firstInvalidOffset ??= this.offset;
    this.info.incompleteTail ||= incomplete;
  }

  line(tail, terminated) {
    const length = this.fragmentBytes + tail.length;
    const bytes = this.fragments.length ? Buffer.concat([...this.fragments, tail], length) : tail;
    this.fragments = [];
    this.fragmentBytes = 0;
    let record;
    try {
      const text = this.decoder.decode(bytes).trim();
      if (text) record = JSON.parse(text);
    } catch {
      this.invalid(!terminated);
    }
    if (record !== undefined) {
      if (!record || typeof record !== 'object' || Array.isArray(record)
          || !(isOverlay(record) ? validId(record.target) : validId(record.id))) {
        this.invalid(false);
      } else {
        this.visit(record);
      }
    }
    this.offset += length + (terminated ? 1 : 0);
  }

  finish() {
    if (this.fragmentBytes) this.line(Buffer.alloc(0), false);
    return this.info;
  }
}

export function scanHistorySync(file, visit) {
  const reader = new RecordReader(visit);
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return reader.finish(); throw error; }
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.allocUnsafe(HISTORY_CHUNK_BYTES);
    for (let position = 0; position < size;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!count) throw changedHistory();
      reader.write(buffer.subarray(0, count));
      position += count;
    }
    return reader.finish();
  } finally { fs.closeSync(fd); }
}

export async function scanHistory(file, visit) {
  const reader = new RecordReader(visit);
  let handle;
  try { handle = await fs.promises.open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return reader.finish(); throw error; }
  try {
    // Snapshot the byte boundary: appends during a page request belong to the
    // next request, and a busy room cannot make this scan run indefinitely.
    const { size } = await handle.stat();
    const buffer = Buffer.allocUnsafe(HISTORY_CHUNK_BYTES);
    for (let position = 0; position < size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw changedHistory();
      reader.write(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return reader.finish();
  } finally { await handle.close(); }
}

export function changedHistory() {
  return Object.assign(new Error('Chat history changed on disk; reload the Store before writing.'), { code: 'HISTORY_CHANGED' });
}

export function normalizeMessage(message) {
  if (!message.reactions || typeof message.reactions !== 'object' || Array.isArray(message.reactions)) message.reactions = {};
  return message;
}

export function hasReaction(message, by, emoji) {
  return Object.hasOwn(message.reactions, emoji) && Array.isArray(message.reactions[emoji]) && message.reactions[emoji].includes(by);
}

export function applyOverlay(message, record) {
  if (!message) return;
  if (record.kind === 'react' && record.emoji) {
    if (!hasReaction(message, record.by, record.emoji)) {
      if (!Object.hasOwn(message.reactions, record.emoji) || !Array.isArray(message.reactions[record.emoji])) {
        Object.defineProperty(message.reactions, record.emoji, { value: [], enumerable: true, configurable: true, writable: true });
      }
      message.reactions[record.emoji].push(record.by);
    }
  } else if (record.kind === 'desc' && message.attach && typeof message.attach === 'object' && record.text) {
    message.attach.desc = String(record.text);
  }
}

// Eviction must not delete a newer instance if an old log contains duplicate IDs.
export function retainMessage(messages, byId, message, capacity) {
  if (messages.length === capacity) {
    const old = messages.shift();
    if (byId.get(old.id) === old) byId.delete(old.id);
  }
  messages.push(normalizeMessage(message));
  byId.set(message.id, message);
}

export function findMessageSync(file, matches) {
  let message = null;
  scanHistorySync(file, (record) => {
    if (isOverlay(record)) {
      if (record.target === message?.id) applyOverlay(message, record);
    } else if (matches(record)) message = normalizeMessage(record);
  });
  return message;
}
