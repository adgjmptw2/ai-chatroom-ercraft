// Persistence: chat log (append-only JSONL), room settings, private notes and the
// shared workspace folder the AIs can read and write.

import fs from 'node:fs';
import path from 'node:path';
import { pick } from './i18n.mjs';
import {
  MAX_RECENT_MESSAGES, MAX_HISTORY_PAGE, scanHistorySync, scanHistory,
  isOverlay, normalizeMessage, hasReaction, applyOverlay, retainMessage,
  findMessageSync, changedHistory,
} from './chat-history.mjs';

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.svg', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.py', '.yaml', '.yml', '.xml', '.tsv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const MAX_FILE_BYTES = 60 * 1024;
const MAX_FILES = 300;
const MAX_NOTE_CHARS = 4000;

// Errors from workspace operations; the AI members read them in the room.
const T = {
  ko: {
    emptyPath: '빈 경로',
    outside: '작업공간 밖 경로',
    tooDeep: '폴더가 너무 깊음',
    badChars: '경로에 쓸 수 없는 문자',
    badExt: (ext) => `허용 안 되는 확장자 ${ext || '(없음)'}`,
    fileMissing: (rel) => `없는 파일 ${rel}`,
    imageWrite: '이미지 파일은 직접 못 씀',
    fileLimit: '파일 개수 한도',
    findMissing: (rel) => `${rel}에서 바꿀 부분을 못 찾음`,
    unknownOp: (op) => `모르는 작업 ${op}`,
    tooBig: (rel) => `${rel} 너무 큼(60KB 초과)`,
  },
  en: {
    emptyPath: 'Empty path',
    outside: 'Path is outside the Workspace',
    tooDeep: 'Folders nested too deep',
    badChars: 'Path has characters that are not allowed',
    badExt: (ext) => `Extension not allowed: ${ext || '(none)'}`,
    fileMissing: (rel) => `No such file ${rel}`,
    imageWrite: "Image files can't be written directly",
    fileLimit: 'File limit reached',
    findMissing: (rel) => `Couldn't find the part to replace in ${rel}`,
    unknownOp: (op) => `Unknown op ${op}`,
    tooBig: (rel) => `${rel} is too big (over 60KB)`,
  },
  ja: {
    emptyPath: '空のパス',
    outside: 'ワークスペースの外のパス',
    tooDeep: 'フォルダが深すぎる',
    badChars: 'パスに使えない文字がある',
    badExt: (ext) => `使えない拡張子 ${ext || '(なし)'}`,
    fileMissing: (rel) => `ファイル ${rel} がない`,
    imageWrite: '画像ファイルは直接書けない',
    fileLimit: 'ファイル数の上限',
    findMissing: (rel) => `${rel} の中に置き換える部分が見つからない`,
    unknownOp: (op) => `知らない操作 ${op}`,
    tooBig: (rel) => `${rel} が大きすぎる(60KB超え)`,
  },
};
const tx = () => pick(T);

export class Store {
  #historyBusy = false;

  constructor(root, { maxMessages = MAX_RECENT_MESSAGES } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_RECENT_MESSAGES) {
      throw new RangeError(`maxMessages must be an integer from 1 to ${MAX_RECENT_MESSAGES}`);
    }
    this.maxMessages = maxMessages;
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.notesDir = path.join(this.dataDir, 'notes');
    this.logDir = path.join(this.dataDir, 'logs');
    this.wsDir = path.join(root, 'workspace');
    for (const d of [this.dataDir, this.notesDir, this.logDir, this.wsDir]) fs.mkdirSync(d, { recursive: true });

    this.msgFile = path.join(this.dataDir, 'messages.jsonl');
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.metaFile = path.join(this.dataDir, 'workspace-meta.json');

    this.messages = [];
    this.byId = new Map();
    this.nextId = 1;
    this.loadMessages();
    this.state = readJson(this.stateFile, {});
    this.meta = readJson(this.metaFile, {});
  }

  // ---------- messages ----------
  loadMessages() {
    this.messages.length = 0;
    this.byId.clear();
    this.nextId = 1;
    this.historyDiagnostics = scanHistorySync(this.msgFile, (rec) => {
      // Recover the high-water mark from the entire log, including records
      // evicted from the window; malformed IDs cannot poison it with NaN.
      if (Number.isSafeInteger(rec.id) && rec.id > 0) this.nextId = Math.max(this.nextId, rec.id + 1);
      if (isOverlay(rec)) applyOverlay(this.byId.get(rec.target), rec);
      else retainMessage(this.messages, this.byId, rec, this.maxMessages);
    });
    if (this.historyDiagnostics.invalidRecords) {
      process.emitWarning(`Chat history has ${this.historyDiagnostics.invalidRecords} invalid record(s), first at byte ${this.historyDiagnostics.firstInvalidOffset}. Original bytes preserved.${this.historyDiagnostics.incompleteTail ? ' Incomplete final record blocks appends until recovered.' : ''}`, { code: 'HISTORY_INVALID_RECORDS' });
    }
  }

  #appendRecord(record) {
    if (this.historyDiagnostics.incompleteTail) {
      throw Object.assign(new Error('Incomplete final chat record; recover the original JSONL tail before appending.'), { code: 'HISTORY_INCOMPLETE_TAIL' });
    }
    let size;
    try { size = fs.statSync(this.msgFile).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; size = 0; }
    if (size !== this.historyDiagnostics.byteLength) throw changedHistory();
    const line = (this.historyDiagnostics.needsNewline ? '\n' : '') + JSON.stringify(record) + '\n';
    fs.appendFileSync(this.msgFile, line);
    this.historyDiagnostics.byteLength += Buffer.byteLength(line);
    this.historyDiagnostics.needsNewline = false;
  }

  addMessage(m) {
    if (!Number.isSafeInteger(this.nextId)) throw new RangeError('Chat message ID space exhausted');
    const msg = normalizeMessage({ ts: Date.now(), reactions: {}, ...m, id: this.nextId });
    this.#appendRecord(msg);
    this.nextId++;
    retainMessage(this.messages, this.byId, msg, this.maxMessages);
    return msg;
  }

  // Toggle-free: an emoji reaction is added once per (member, emoji).
  applyReaction(targetId, by, emoji, persist = true) {
    if (!emoji) return null;
    // Rare old-target writes scan with one retained message. They remain sync
    // and return the updated record without repopulating the recent window.
    const msg = this.getMessage(targetId);
    if (!msg || hasReaction(msg, by, emoji)) return null;
    const record = { kind: 'react', target: targetId, by, emoji, ts: Date.now() };
    if (persist) this.#appendRecord(record);
    applyOverlay(msg, record);
    return msg;
  }

  // Text description of an uploaded photo, for the members whose CLI cannot take images.
  setAttachDesc(targetId, text, persist = true) {
    if (!text) return null;
    const msg = this.getMessage(targetId);
    if (!msg?.attach || typeof msg.attach !== 'object') return null;
    const record = { kind: 'desc', target: targetId, text: String(text), ts: Date.now() };
    if (persist) this.#appendRecord(record);
    applyOverlay(msg, record);
    return msg;
  }

  // Explicit full-history lookups for replies, mentions, and attachment reuse.
  // Cache hits retain existing object identity; old records are detached and
  // reconstructed synchronously with O(one record) memory, without caching.
  getMessage(id) {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return this.byId.get(id) ?? findMessageSync(this.msgFile, (rec) => rec.id === id);
  }

  getMessageByAttachment(attachmentPath) {
    if (typeof attachmentPath !== 'string' || !attachmentPath) return null;
    const cached = this.messages.findLast((msg) => msg.attach?.path === attachmentPath);
    return cached ?? findMessageSync(this.msgFile, (rec) => rec.attach?.path === attachmentPath);
  }

  // Ascending log order, strict/exclusive cursor. Only one disk page scan may
  // run per Store; callers can retry HISTORY_BUSY (there is no unbounded queue).
  // Replay through the snapshot EOF even after reaching the cursor, so late
  // reactions/descriptions are applied to the page's at-most-200 records.
  async historyBefore(before = Infinity, limit = MAX_HISTORY_PAGE) {
    const cursor = Number(before);
    const requested = Number(limit);
    if (Number.isNaN(cursor) || Number.isNaN(requested)) throw new TypeError('Invalid history cursor or limit');
    const capacity = Math.min(MAX_HISTORY_PAGE, Math.max(0, Math.floor(requested)));
    if (!capacity || cursor <= 1) return [];
    if (this.#historyBusy) throw Object.assign(new Error('Chat history scan already in progress; retry this request.'), { code: 'HISTORY_BUSY' });
    this.#historyBusy = true;
    try {
      const messages = [], byId = new Map();
      await scanHistory(this.msgFile, (rec) => {
        if (isOverlay(rec)) applyOverlay(byId.get(rec.target), rec);
        else if (rec.id < cursor) retainMessage(messages, byId, rec, capacity);
      });
      return messages;
    } finally { this.#historyBusy = false; }
  }

  get lastId() { return this.nextId - 1; }
  lastMessage() { return this.messages[this.messages.length - 1]; }
  after(id) {
    // messages are in id order; walk backwards for speed
    const out = [];
    for (let i = this.messages.length - 1; i >= 0 && this.messages[i].id > id; i--) out.push(this.messages[i]);
    return out.reverse();
  }
  recent(n) { return this.messages.slice(-n); }

  // ---------- room state ----------
  saveState() { writeJson(this.stateFile, this.state); }

  // ---------- notes (private per AI) ----------
  readNote(id) {
    const f = path.join(this.notesDir, `${id}.md`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }
  writeNote(id, text) {
    let t = String(text ?? '');
    if (t.length > MAX_NOTE_CHARS) t = t.slice(t.length - MAX_NOTE_CHARS);
    fs.writeFileSync(path.join(this.notesDir, `${id}.md`), t);
    return t;
  }
  appendNote(id, line) {
    const cur = this.readNote(id);
    return this.writeNote(id, (cur ? cur.replace(/\s*$/, '\n') : '') + String(line).trim() + '\n');
  }

  // ---------- workspace ----------
  // Returns a safe relative path (forward slashes) or throws.
  safeRel(p) {
    let rel = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel) throw new Error(tx().emptyPath);
    rel = path.posix.normalize(rel);
    if (rel.startsWith('..') || path.posix.isAbsolute(rel) || rel.includes('\0')) throw new Error(tx().outside);
    if (rel.split('/').length > 4) throw new Error(tx().tooDeep);
    if (!/^[\p{L}\p{N} _.\-()/]+$/u.test(rel)) throw new Error(tx().badChars);
    const ext = path.posix.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext) && !IMAGE_EXT.has(ext)) throw new Error(tx().badExt(ext));
    return rel;
  }
  abs(rel) { return path.join(this.wsDir, ...rel.split('/')); }
  isImage(rel) { return IMAGE_EXT.has(path.posix.extname(rel).toLowerCase()); }

  listFiles() {
    const out = [];
    const walk = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
        else {
          const st = fs.statSync(path.join(dir, ent.name));
          const m = this.meta[rel] || {};
          out.push({ path: rel, size: st.size, mtime: st.mtimeMs, by: m.by || null, createdBy: m.createdBy || m.by || null });
        }
      }
    };
    walk(this.wsDir, '');
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  readFile(p) {
    const rel = this.safeRel(p);
    const f = this.abs(rel);
    if (!fs.existsSync(f)) throw new Error(tx().fileMissing(rel));
    if (this.isImage(rel)) return { rel, image: true, size: fs.statSync(f).size };
    return { rel, text: fs.readFileSync(f, 'utf8') };
  }

  // op: {op: write|append|edit|delete, path, content, find, replace}
  applyFileOp(op, by) {
    const rel = this.safeRel(op.path);
    if (this.isImage(rel) && op.op !== 'delete') throw new Error(tx().imageWrite);
    const f = this.abs(rel);
    const exists = fs.existsSync(f);
    let text;
    switch (op.op) {
      case 'write':
        if (!exists && this.listFiles().length >= MAX_FILES) throw new Error(tx().fileLimit);
        text = String(op.content ?? '');
        break;
      case 'append': {
        const cur = exists ? fs.readFileSync(f, 'utf8') : '';
        const add = String(op.content ?? '');
        // Models often omit the leading newline when appending a line.
        const glue = cur && !cur.endsWith('\n') && !add.startsWith('\n') ? '\n' : '';
        text = cur + glue + add;
        break;
      }
      case 'edit': {
        if (!exists) throw new Error(tx().fileMissing(rel));
        const cur = fs.readFileSync(f, 'utf8');
        const find = String(op.find ?? '');
        if (!find || !cur.includes(find)) throw new Error(tx().findMissing(rel));
        text = cur.replace(find, String(op.replace ?? ''));
        break;
      }
      case 'delete':
        if (!exists) throw new Error(tx().fileMissing(rel));
        fs.rmSync(f);
        delete this.meta[rel];
        writeJson(this.metaFile, this.meta);
        return { rel, op: 'delete' };
      default:
        throw new Error(tx().unknownOp(op.op));
    }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(tx().tooBig(rel));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    this.touchMeta(rel, by, !exists);
    return { rel, op: exists ? op.op : 'create', size: Buffer.byteLength(text) };
  }

  // Register a binary file (generated image) that was copied into the workspace.
  touchMeta(rel, by, created) {
    const m = (this.meta[rel] ??= {});
    if (created || !m.createdBy) m.createdBy = by;
    m.by = by;
    m.at = Date.now();
    writeJson(this.metaFile, this.meta);
  }

  log(id, text) {
    const line = `[${new Date().toISOString()}] ${text}\n`;
    fs.appendFileSync(path.join(this.logDir, `${id}.log`), line);
  }
}

function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return dflt; throw error; }
}
function writeJson(f, v) {
  const temp = `${f}.save-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(v, null, 2)); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, f);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}
