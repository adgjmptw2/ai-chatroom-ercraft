// CLI adapters: one headless call per turn for each AI, plus image generation for the
// members whose CLI has an image tool. Everything goes through the user's logged-in
// CLIs (claude, codex, grok, agy); no API keys are used.
//
// Safety: chat calls run with every tool disabled or denied. Image calls allow only
// the image tool (Grok) or run sandboxed (Codex workspace sandbox, agy --sandbox).
// Grok ignores `--tools ""`, so its chat calls remove every tool it lets us remove
// and run in dontAsk mode, which cancels any call to the few tools that remain.

import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { LIAR_TURN_SCHEMA, liarStructuredReply } from './liar-turn.mjs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hiveAvailable, hiveChat } from './hive.mjs';
import { GeminiSession, geminiIdentity, geminiReply } from './gemini-session.mjs';
import { pick } from './i18n.mjs';
import { validatePhotocardReferences } from './photocards.mjs';
import { CONSTRUCTION_ACTIONS, constructionAllowed } from './world-actions.mjs';

const HOME = os.homedir();

// Prompt texts in the room language: the photo notes added to Grok / Gemini photo turns,
// and the photo-description request (the description is written in the room language).
const T = {
  ko: {
    grokPhotos: (names) => `[사진 파일] 붙인 사진은 ${names}에 있어(순서대로). read_file로 이 파일들만 열어서 직접 봐. 다른 파일은 열지 마.`,
    geminiPhotos: (names) => `[사진 파일] 붙인 사진은 지금 작업 폴더에 ${names}로 있어(순서대로). 파일 보기 도구로 열어서 직접 봐. 다른 파일은 열지 마.`,
    describe: '이 사진을 직접 못 보는 채팅 멤버들한테 설명해줘. 한국어 평서문("~있다", "~보인다")으로 2~4문장: 뭐가 찍혔는지, 눈에 띄는 디테일, 분위기. 사진 속 글자는 보이는 그대로 옮겨. 안 보이는 건 지어내지 마. 설명만 출력해.',
    describeSystem: '요청받은 사진 설명만 출력해.',
  },
  en: {
    grokPhotos: (names) => `[Photo files] The attached photos are at ${names} (in order). Open only these files with read_file and look at them yourself. Don't open any other file.`,
    geminiPhotos: (names) => `[Photo files] The attached photos are in the current working folder as ${names} (in order). Open them with your file viewing tool and look at them yourself. Don't open any other file.`,
    describe: 'Describe this photo for chat members who can\'t see it. Write 2-4 plain declarative sentences in English ("There is ...", "It shows ..."): what is in it, details that stand out, the mood. Copy any text in the photo exactly as it appears. Don\'t make up anything you can\'t see. Output only the description.',
    describeSystem: 'Output only the requested photo description.',
  },
  ja: {
    grokPhotos: (names) => `[写真ファイル] 添付した写真は ${names} にある(順番どおり)。read_file でこのファイルだけ開いて自分で見て。ほかのファイルは開かないで。`,
    geminiPhotos: (names) => `[写真ファイル] 添付した写真は今の作業フォルダに ${names} として置いてある(順番どおり)。ファイルを見るツールで開いて自分で見て。ほかのファイルは開かないで。`,
    describe: 'この写真を直接見られないチャットメンバーのために説明して。日本語の常体(だ・である調)の平叙文(「〜がある」「〜が見える」)で2〜4文: 何が写っているか、目立つディテール、雰囲気。写真の中の文字は見えるとおりに書き写して。見えないものを想像で付け足さないで。説明だけを出力して。',
    describeSystem: '頼まれた写真の説明だけを出力して。',
  },
};
const tx = () => pick(T);

const GROK_TOOLS = ['run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep', 'kill_command_or_subagent',
  'todo_write', 'get_command_or_subagent_output', 'spawn_subagent', 'scheduler_create', 'scheduler_delete', 'scheduler_list',
  'monitor', 'search_tool', 'use_tool', 'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'write', 'web_fetch'].join(',');

const WIN = process.platform === 'win32';
const exe = (name) => (WIN ? `${name}.exe` : name);

export function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, name);
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

// <root>/<any>/<rest...>: newest match (for versioned install folders).
function newestUnder(root, ...rest) {
  if (!root || !fs.existsSync(root)) return null;
  const hits = fs.readdirSync(root).map((d) => path.join(root, d, ...rest)).filter((f) => fs.existsSync(f));
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

// Finds the four CLIs. `overrides` is config.json "bins" ({claude, codex, grok, agy}: full
// paths) and wins over everything. Otherwise PATH, then the usual install folders.
// On Windows npm installs `.cmd` shims, which cannot be spawned without a shell, so the real
// executables inside the npm packages are looked up instead.
export function resolveBins(overrides = {}) {
  const npmRoot = WIN ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules') : null;
  const first = (...c) => c.find((f) => f && fs.existsSync(f)) || null;
  return {
    claude: overrides.claude || newestClaude([
      onPath(exe('claude')),
      path.join(HOME, '.local', 'bin', exe('claude')),
      npmRoot && path.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    ]),
    codex: overrides.codex || first(
      onPath(exe('codex')),
      // official standalone installer
      WIN ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
        : path.join(HOME, '.local', 'bin', 'codex'),
      WIN && newestUnder(path.join(HOME, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'), 'codex.exe'), // Codex desktop app
      npmRoot && newestUnder(path.join(npmRoot, '@openai', 'codex', 'vendor'), 'codex', 'codex.exe'),
    ),
    grok: overrides.grok || first(onPath(exe('grok')), path.join(HOME, '.grok', 'bin', exe('grok'))),
    agy: overrides.agy || first(
      onPath(exe('agy')),
      WIN ? path.join(HOME, 'AppData', 'Local', 'agy', 'bin', 'agy.exe') : path.join(HOME, '.local', 'bin', 'agy'),
    ),
  };
}

// Several Claude Code installs can coexist (native installer in ~/.local/bin, npm global);
// newer models need a newer CLI, so use whichever reports the highest version.
function newestClaude(cands) {
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
    return 0;
  };
  let best = null, bestVer = null;
  for (const f of new Set(cands.filter((c) => c && fs.existsSync(c)))) {
    let ver;
    try {
      const out = execFileSync(f, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      ver = (out.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    } catch { continue; }
    if (!bestVer || cmp(ver, bestVer) > 0) { best = f; bestVer = ver; }
  }
  return best;
}

// Children are spawned in their own process group on macOS/Linux (see spawnOpts), so the
// whole tree can be killed there too.
export function killTree(pid) {
  if (!pid) return;
  if (WIN) { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
export const spawnOpts = { windowsHide: true, detached: !WIN };

// Track children so the server can kill them on shutdown.
export const running = new Set();
const hiveRequests = new Set();

export function run(cmd, args, { input, cwd, timeoutMs = 150000, env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = [], err = [];
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, ...spawnOpts, env: env ? { ...process.env, ...env } : process.env });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e), ms: 0 });
      return;
    }
    running.add(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => err.push(Buffer.from(String(e))));
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(child);
      resolve({
        code: timedOut ? -2 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Date.now() - t0,
        timedOut,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function killAll() {
  for (const controller of hiveRequests) controller.abort();
  for (const c of running) killTree(c.pid);
}

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// Constrain the transport envelope, not character choices. Existing optional room
// actions remain available and are validated by their normal server handlers.
const chatString = { type: 'string' };
const chatInteger = { type: 'integer' };
const chatPoint = { type: 'array', items: chatInteger };
const chatVector = { type: 'array', items: { type: 'number' } };
const chatObject = properties => ({ type: 'object', properties, additionalProperties: true });
const chatPlanRef = chatObject({ id: chatString });
const chatBlock = chatObject({ name: chatString, pixels: { type: 'array', items: chatString },
  colors: { type: 'object', additionalProperties: chatString }, glow: { type: 'boolean' }, clear: { type: 'boolean' } });
export const CLAUDE_CHAT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['say', 'pass'] },
    messages: { type: 'array', items: { type: 'string' } },
    reply_to: { type: 'integer' },
    // Leaving these undeclared caused native structured output to stringify files.
    files: { type: 'array', items: { ...chatObject({ op: { type: 'string', enum: ['write', 'append', 'edit', 'delete'] },
      path: chatString, content: chatString, find: chatString, replace: chatString }), required: ['op', 'path'] } },
    show: chatString, open: chatString, sticker: chatString,
    sticker_save: chatObject({ from: chatString, to: chatString }),
    react: chatObject({ id: chatInteger, emoji: chatString }),
    note_add: chatString, note_replace: chatString, boost: chatString,
    image: { anyOf: [chatString, chatObject({ prompt: chatString, ref: chatString, save_as: chatString,
      photocard: { type: 'boolean' }, subjects: { type: 'array', items: chatString, minItems: 1, maxItems: 4 },
      style: { type: 'string', enum: ['snapshot', 'photocard'] },
      effort: { type: 'string', enum: ['medium', 'xhigh'] } })] },
    plan_request: chatObject({ title: chatString, brief: chatString, site: chatPoint }),
    build_plan: chatObject({ id: chatString, stage: { anyOf: [chatString, chatInteger] }, continue: { type: 'boolean' } }),
    plan_pause: chatPlanRef, plan_cancel: chatPlanRef,
    build: { type: 'array', items: chatObject({ op: chatString, at: chatPoint, from: chatPoint, to: chatPoint,
      block: chatString, shape: chatString, facing: chatString, text: chatString,
      glow: { type: 'boolean' }, width: { type: 'number' }, bg: chatString, color: chatString }) },
    block_define: { anyOf: [chatBlock, { type: 'array', items: chatBlock }] },
    move: { anyOf: [chatPoint, chatObject({ x: chatInteger, z: chatInteger })] },
    useFurniture: chatPoint,
    leisure: { type: 'object', properties: {
      kind: { type: 'string', enum: ['sleep','rest','write','draw','read','music','walk','tidy'] },
      minutes: { type: 'integer', minimum: 1, maximum: 60 },
    }, required: ['kind'], additionalProperties: false },
    living: chatObject({ op: { type: 'string', enum: ['cook','serve','eat','meal_clear','game_create','game_join','game_move','game_leave','table_set','table_clear','blanket_spread','blanket_fold','relax'] },
      recipe: { type: 'string', enum: ['soup','burger','tea','toast','dumplings','cookies','fruit'] },
      spot: { type:'string', enum:['sofa-1','sofa-2','sofa-3','sofa-4','adina-bed','bianca-bed','eleven-bed','lucia-bed'] },
      style: { type:'string', enum:['mint','butter','pink','lavender'] }, mealId: chatString, gameId: chatString,
      revision: chatInteger, cell: { type: 'integer', minimum: 0, maximum: 8 } }),
    world_look: chatObject({ y: chatInteger, x1: chatInteger, z1: chatInteger, x2: chatInteger, z2: chatInteger }),
    world_shot: chatObject({ night: { type: 'boolean' }, view: chatString, at: chatVector,
      from: chatVector, look_at: chatVector, quat: chatVector, dist: { type: 'number' } }),
  },
  required: ['action'],
  additionalProperties: true,
});

export const LIVING_CHAT_SCHEMA = Object.freeze({
  ...CLAUDE_CHAT_SCHEMA,
  properties: Object.fromEntries(Object.entries(CLAUDE_CHAT_SCHEMA.properties).filter(([key]) => !CONSTRUCTION_ACTIONS.includes(key))),
  additionalProperties: false,
});

export function claudeStructuredReply(envelope) {
  const action = envelope?.structured_output;
  if (envelope?.type !== 'result' || envelope.is_error !== false || envelope.subtype !== 'success'
    || !action || typeof action !== 'object' || Array.isArray(action)
    || !['say', 'pass'].includes(action.action)
    || action.messages !== undefined && (!Array.isArray(action.messages) || !action.messages.every(s => typeof s === 'string'))
    || action.action === 'say' && !action.messages?.some(s => s.trim())
    || action.reply_to !== undefined && !Number.isSafeInteger(action.reply_to)) return '';
  if (Object.hasOwn(action, 'files')) {
    // Decode only the known legacy container once. File contents are opaque bytes:
    // do not unescape SVG/code, recursively decode, or invent missing operations.
    let files = action.files;
    if (typeof files === 'string') {
      try { files = JSON.parse(files); } catch { return ''; }
    }
    if (!Array.isArray(files) || !files.every(op => op && typeof op === 'object' && !Array.isArray(op)
      && typeof op.path === 'string' && op.path.trim()
      && (['write', 'append'].includes(op.op) ? typeof op.content === 'string'
        : op.op === 'edit' ? typeof op.find === 'string' && !!op.find && typeof op.replace === 'string'
          : op.op === 'delete'))) return '';
    return JSON.stringify({ ...action, files });
  }
  return JSON.stringify(action);
}

// `claude -p` with images: one stream-json user message (image blocks + the text), still
// with every tool off. Returns {r, text} like a plain call.
async function claudeWithImages(bin, args, text, images, { cwd, timeoutMs }) {
  const content = images.map((f) => ({
    type: 'image',
    source: { type: 'base64', media_type: IMAGE_MIME[path.extname(f).toLowerCase()] || 'image/png', data: fs.readFileSync(f).toString('base64') },
  }));
  content.push({ type: 'text', text });
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  const r = await run(bin, [...args, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { input, cwd, timeoutMs });
  let out = '';
  for (const line of r.stdout.split('\n')) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'result') {
      out = args.includes('--json-schema') ? claudeStructuredReply(j) : j.is_error ? '' : String(j.result ?? '');
      if (j.is_error) r.stderr += `\nresult error: ${String(j.result ?? j.subtype).slice(0, 300)}`;
    }
  }
  return { r, text: out };
}

// ---------------------------------------------------------------------------
// Chat turn. Returns {ok, text, ms, detail}.

// Deliberately independent of the members' models, boost settings and web toggle.
export function planArgs(cfg, outFile) {
  const disabled = ['shell_tool', 'unified_exec', 'computer_use', 'browser_use', 'browser_use_external',
    'apps', 'plugins', 'image_generation', 'view_image', 'multi_agent', 'multi_agent_v2',
    'code_mode', 'code_mode_host', 'artifact', 'goals', 'sleep_tool', 'hooks', 'memories',
    'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest'];
  return ['exec', ...(cfg.codexBaseUrl ? ['-c', `openai_base_url=${JSON.stringify(cfg.codexBaseUrl)}`] : []),
    '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="xhigh"',
    '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'read-only',
    ...disabled.flatMap((feature) => ['--disable', feature]),
    '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0',
    '-c', 'windows.sandbox="unelevated"', '--color', 'never', '-o', outFile, '-'];
}

export class Adapters {
  constructor(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.bins = resolveBins(cfg.bins || {});
    this.sessions = {}; // gemini conversation rotation
  }

  cwd(id, sub = 'chat') {
    const d = path.join(this.root, 'data', 'cwd', id, sub);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  available() {
    const b = this.bins;
    return {
      claude: !!b.claude && fs.existsSync(b.claude),
      gpt: !!b.codex && fs.existsSync(b.codex),
      deepseek: hiveAvailable(this.cfg),
      gemini: fs.existsSync(b.agy),
    };
  }

  // Longest prompt a backend accepts (agy takes the prompt as a command-line argument).
  maxPromptChars(id) { return id === 'gemini' ? 26000 : 120000; }

  // One design call, never a chat session or a fallback. Only the local admin log
  // receives bounded diagnostics; the returned error does not expose routing.
  async plan(prompt) {
    const started = Date.now();
    const timeoutSec = this.cfg.planner?.timeoutSec ?? 600;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24000
      || !Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 600) {
      return { ok: false, text: '', ms: 0, detail: '설계 요청 설정이 올바르지 않아.' };
    }
    const parent = path.join(this.root, 'data', 'cwd', 'planner');
    let job, result, diagnostic = '';
    try {
      fs.mkdirSync(parent, { recursive: true });
      job = fs.mkdtempSync(path.join(parent, 'design-'));
      const outFile = path.join(job, 'recipe.txt');
      const r = await run(this.bins.codex, planArgs(this.cfg, outFile), { input: prompt, cwd: job, timeoutMs: timeoutSec * 1000 });
      let text = '';
      if (fs.existsSync(outFile) && fs.statSync(outFile).size <= 32768) text = fs.readFileSync(outFile, 'utf8').trim();
      diagnostic = `exit=${r.code} ${r.stderr.slice(-1200)}\n${text.slice(0, 2000)}`;
      result = { ok: r.code === 0 && !!text, text: r.code === 0 ? text : '', ms: r.ms };
      if (!result.ok) result.detail = r.timedOut ? '설계 응답 시간이 초과됐어.' : '설계 응답을 받지 못했어.';
    } catch (e) {
      diagnostic = String(e.message || e).slice(0, 1200);
      result = { ok: false, text: '', ms: Date.now() - started, detail: '설계 호출을 완료하지 못했어.' };
    } finally {
      // job is a freshly created child of this dedicated scratch directory.
      if (job && path.dirname(path.resolve(job)) === path.resolve(parent)) {
        try { fs.rmSync(job, { recursive: true, force: true }); } catch { /* scratch only */ }
      }
    }
    try {
      const logs = path.join(this.root, 'data', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.appendFileSync(path.join(logs, 'planner.jsonl'), JSON.stringify({ at: started, ok: result.ok, ms: result.ms, detail: diagnostic }) + '\n');
    } catch { /* Logging cannot turn one completed call into a retry. */ }
    return result;
  }

  // Who can look at photos. Claude (stream-json image blocks) and Codex (--image) get them
  // with the turn, tools still off. agy's stream input is text only, but in headless mode
  // it may read files in its cwd (and temp), so a Gemini photo turn runs in a folder that
  // holds only the photo copies. Grok can't: ACP says image:false, and its read_file tool
  // reads the whole disk whatever --allow says (its sandbox profiles are Linux/macOS only),
  // so by default Grok gets the text description (describeImage).
  // agents.grok.seePhotos: true lets Grok look through read_file on photo turns instead. Its
  // read_file can read ANY file on the computer (path rules are ignored on Windows), so only
  // turn it on if you accept that; see the grok case in chat().
  canSee(id) {
    if (id === 'grok') return this.cfg.agents.grok?.seePhotos === true;
    return id === 'claude' || id === 'gpt' || id === 'gemini';
  }

  // agy always lets the model read the temp folder, so point TEMP/TMP at an empty room-only
  // folder for every agy call; the user's real %TEMP% stays out of reach.
  agyEnv() {
    const tmp = path.join(this.root, 'data', 'tmp', 'agy');
    fs.mkdirSync(tmp, { recursive: true });
    return { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  }

  // opts.boost: this turn runs on the member's boost settings (진심모드): agents.<id>.boost
  // overrides model and/or effort. Missing boost settings fall back to the defaults.
  // opts.images: absolute paths of photos to attach (only for members that canSee).
  async chat(id, brief, turn, opts = {}) {
    if (id === 'gemini') return this.geminiChat(brief, turn, opts);
    if (id === 'deepseek') {
      const controller = new AbortController();
      hiveRequests.add(controller);
      const timer = setTimeout(() => controller.abort(), (this.cfg.turnTimeoutSec || 150) * 1000);
      try {
        const result = await hiveChat(this.cfg, brief, turn, { signal: controller.signal });
        const dir = path.join(this.root, 'data');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'hive-usage.jsonl'), JSON.stringify({ at: Date.now(), model: this.cfg.agents.deepseek.model, ok: result.ok, usage: result.usage ?? null }) + '\n');
        return result;
      } finally { clearTimeout(timer); hiveRequests.delete(controller); }
    }
    const images = this.canSee(id) ? (opts.images || []).filter((f) => fs.existsSync(f)) : [];
    // Web search (config webSearch): each CLI's own search tool, nothing that opens pages
    // locally. agy's search_web runs in headless mode regardless (its read_url is denied).
    const search = !!this.cfg.webSearch && !opts.game;
    const base = this.cfg.agents[id];
    const a = opts.boost && (base.boost?.model || base.boost?.effort) ? { ...base, ...base.boost } : base;
    // 진심모드 turns think for a long time (a rulebook plus a worked example took >150s).
    const timeoutMs = ((opts.boost && this.cfg.boost?.timeoutSec) || this.cfg.turnTimeoutSec || 150) * 1000;
    const cwd = this.cwd(id);
    let r, text;
    switch (id) {
      case 'claude': {
        const sysFile = path.join(cwd, 'system.md');
        fs.writeFileSync(sysFile, brief);
        // Web search on: the WebSearch tool only (no WebFetch, so no arbitrary URLs).
        const tools = search ? ['--tools', 'WebSearch', '--allowedTools', 'WebSearch'] : ['--tools', ''];
        const args = ['-p', '--model', a.model, ...tools, '--strict-mcp-config', '--no-session-persistence',
          '--setting-sources', '', '--system-prompt-file', sysFile,
          '--json-schema', JSON.stringify(opts.game ? LIAR_TURN_SCHEMA : constructionAllowed(this.cfg) ? CLAUDE_CHAT_SCHEMA : LIVING_CHAT_SCHEMA)];
        if (a.effort) args.push('--effort', a.effort);
        if (images.length) {
          ({ r, text } = await claudeWithImages(this.bins.claude, args, turn, images, { cwd, timeoutMs }));
        } else {
          r = await run(this.bins.claude, [...args, '--output-format', 'json'], { input: turn, cwd, timeoutMs });
          try {
            const result = JSON.parse(r.stdout);
            text = opts.game ? liarStructuredReply(result) : claudeStructuredReply(result);
            // The CLI emits quota/authentication errors on stdout with no
            // stderr. Preserve that reason in private diagnostics, not chat.
            if (result.is_error) r.stderr += `\nresult error: ${String(result.result ?? result.subtype).slice(0, 300)}`;
          } catch { text = ''; }
        }
        if (!text) r.stderr += '\nMissing or invalid structured chat action';
        break;
      }
      case 'gpt': {
        const outFile = path.join(cwd, `reply-${crypto.randomUUID()}.txt`);
        const args = ['exec', ...(this.cfg.codexBaseUrl ? ['-c', `openai_base_url=${JSON.stringify(this.cfg.codexBaseUrl)}`] : []), '-m', a.model, '-c', `model_reasoning_effort="${a.effort || 'low'}"`,
          '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'read-only',
          '--disable', 'shell_tool', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'apps',
          // "indexed" searches OpenAI's index instead of fetching pages live.
          '-c', `web_search="${search ? 'indexed' : 'disabled'}"`,
          '-c', 'windows.sandbox="unelevated"', ...images.map((f) => `--image=${f}`), '--color', 'never', '-o', outFile, '-'];
        r = await run(this.bins.codex, args, { input: `${brief}\n\n=====\n\n${turn}`, cwd, timeoutMs });
        try { text = fs.readFileSync(outFile, 'utf8'); fs.rmSync(outFile); } catch { text = ''; }
        break;
      }
      case 'grok': {
        // Photo turns: read_file on (only way Grok's CLI can look at a picture), run in a
        // folder holding only the photo copies, and web search off for that turn so file
        // reading and the network are never open together. Other turns: no file tools.
        let viewDir = null;
        let prompt = `${brief}\n\n=====\n\n${turn}`;
        if (images.length) {
          viewDir = path.join(this.root, 'data', 'view', 'grok', crypto.randomUUID());
          fs.mkdirSync(viewDir, { recursive: true });
          const names = images.map((f, i) => {
            const n = `photo${i + 1}${path.extname(f).toLowerCase()}`;
            fs.copyFileSync(f, path.join(viewDir, n));
            return path.join(viewDir, n);
          });
          prompt += `\n\n${tx().grokPhotos(names.join(', '))}`;
        }
        const pf = path.join(cwd, 'prompt.txt');
        fs.writeFileSync(pf, prompt);
        const disallowed = viewDir ? GROK_TOOLS.split(',').filter((t) => t !== 'read_file').join(',') : GROK_TOOLS;
        const args = ['--prompt-file', pf, '-m', a.model, '--effort', a.effort || 'low',
          ...(viewDir ? ['--tools', 'read_file'] : []),
          '--disallowed-tools', disallowed, '--permission-mode', 'dontAsk',
          '--output-format', 'plain', '--no-subagents', ...(search && !viewDir ? [] : ['--disable-web-search']), '--cwd', viewDir || cwd];
        // Search runs on xAI's side (its "open_page" can't be split off); the local
        // web_fetch tool stays off either way.
        try {
          r = await run(this.bins.grok, args, { cwd: viewDir || cwd, timeoutMs, env: { GROK_WEB_FETCH: 'false' } });
        } finally {
          if (viewDir) fs.rmSync(viewDir, { recursive: true, force: true });
        }
        text = r.stdout;
        break;
      }
      default:
        throw new Error(`unknown agent ${id}`);
    }
    const ok = r.code === 0 && !!text?.trim();
    return { ok, text: text || '', ms: r.ms, detail: ok ? '' : `exit=${r.code}${r.timedOut ? ' (timeout)' : ''} ${r.stderr.slice(-600)}` };
  }

  async geminiChat(brief, turn, opts = {}) {
    const started = Date.now();
    // A private role card must never enter or invalidate the ordinary chat seed.
    const session = opts.game ? new GeminiSession() : (this.sessions.gemini ??= new GeminiSession());
    let viewDir = null, r, request, reply;
    try {
      try {
        const base = this.cfg.agents.gemini;
        const a = opts.boost && (base.boost?.model || base.boost?.effort) ? { ...base, ...base.boost } : base;
        const timeoutMs = ((opts.boost && this.cfg.boost?.timeoutSec) || this.cfg.turnTimeoutSec || 150) * 1000;
        const cwd = this.cwd('gemini');
        const images = (opts.images || []).filter(f => fs.existsSync(f));
        let prompt = `${brief}\n\n=====\n\n${turn}`;
        if (images.length) {
          // Photo calls keep the existing dedicated folder and full brief.
          viewDir = path.join(this.root, 'data', 'view', 'gemini', crypto.randomUUID());
          fs.mkdirSync(viewDir, { recursive: true });
          const names = images.map((f, i) => {
            const name = `photo${i + 1}${path.extname(f).toLowerCase()}`;
            fs.copyFileSync(f, path.join(viewDir, name));
            return name;
          });
          prompt += `\n\n${tx().geminiPhotos(names.join(', '))}`;
        }
        const workDir = viewDir || cwd;
        const env = this.agyEnv();
        const args = ['--model', a.model, '--output-format', 'json', '--print-timeout', `${Math.round(timeoutMs / 1000)}s`];
        const identity = geminiIdentity({ brief, bin: this.bins.agy, args, cwd: path.resolve(workDir),
          settings: { agent: a, webSearch: !!this.cfg.webSearch }, env: { ...process.env, ...env } });
        // Even an unavailable photo attachment must not consume the normal seed.
        request = session.begin(identity, a.rotate, !!opts.game || !!opts.boost || !!opts.images?.length);
        if (request.id) {
          args.push('--conversation', request.id);
          prompt = turn; // The entire current turn/history stays byte-for-byte intact.
        }
        args.push('-p', prompt);
        r = await run(this.bins.agy, args, { cwd: workDir, timeoutMs: timeoutMs + 10000, env });
        reply = geminiReply(r, request);
      } finally {
        if (viewDir) fs.rmSync(viewDir, { recursive: true, force: true });
      }
      session.succeed(request, reply.id);
      return { ok: true, text: reply.text, ms: r.ms, detail: '' };
    } catch (error) {
      // Includes preparation, process, timeout, response and cleanup failures,
      // including failures in isolated boost/photo calls. Never retry the model.
      session.invalidate();
      const reason = error?.message ?? String(error);
      const detail = `${r?.stderr || ''}${reason ? `\n${reason}` : ''}`.slice(-600);
      return { ok: false, text: '', ms: r?.ms ?? Date.now() - started,
        detail: `exit=${r ? r.code : -1}${r?.timedOut ? ' (timeout)' : ''} ${detail}` };
    }
  }

  // -------------------------------------------------------------------------
  // Photo description for the members that can't take images. One no-tools call per
  // upload (Claude's default chat model, Codex as the fallback). Returns {ok, text, detail}.
  async describeImage(file) {
    const ask = tx().describe;
    const cwd = this.cwd('describe');
    const timeoutMs = 90000;
    const tidy = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (this.bins.claude && fs.existsSync(this.bins.claude)) {
      const args = ['-p', '--model', this.cfg.agents.claude?.model || 'sonnet', '--tools', '', '--strict-mcp-config',
        '--no-session-persistence', '--setting-sources', '', '--system-prompt', tx().describeSystem];
      const { r, text } = await claudeWithImages(this.bins.claude, args, ask, [file], { cwd, timeoutMs });
      if (r.code === 0 && tidy(text)) return { ok: true, text: tidy(text) };
    }
    if (this.bins.codex && fs.existsSync(this.bins.codex)) {
      const outFile = path.join(cwd, `desc-${crypto.randomUUID()}.txt`);
      const args = ['exec', ...(this.cfg.codexBaseUrl ? ['-c', `openai_base_url=${JSON.stringify(this.cfg.codexBaseUrl)}`] : []), '-m', this.cfg.agents.gpt?.model || 'gpt-6-sol', '-c', 'model_reasoning_effort="low"',
        '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'read-only',
        '--disable', 'shell_tool', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'apps',
        '-c', 'windows.sandbox="unelevated"', `--image=${file}`, '--color', 'never', '-o', outFile, '-'];
      const r = await run(this.bins.codex, args, { input: ask, cwd, timeoutMs });
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); fs.rmSync(outFile); } catch { /* none */ }
      if (r.code === 0 && tidy(text)) return { ok: true, text: tidy(text) };
      return { ok: false, detail: `exit=${r.code} ${r.stderr.slice(-300)}` };
    }
    return { ok: false, detail: 'no vision CLI' };
  }

  // -------------------------------------------------------------------------
  // Image generation. Returns {ok, file (absolute path of a png/jpg), detail}.
  // opts.refSheet: absolute path of a character sheet to draw from (looks only). Codex takes
  // it with --image, agy reads a copy in its job folder; Grok's image turn can't take one.
  // Photocards use private refSheets + referenceRoot, independently of member routing.
  async image(id, prompt, opts = {}) {
    const photocard = opts.photocard === true;
    let refs;
    if (photocard) {
      try { refs = validatePhotocardReferences(opts.refSheets, opts.referenceRoot); }
      catch { return { ok: false, detail: 'photocard_references' }; }
      id = 'gpt';
    }
    const job = this.cwd(id, `img-${Date.now()}${photocard ? `-${crypto.randomUUID()}` : ''}`);
    const REF_NOTE = 'The attached character design sheet is an appearance reference only (hair, eyes, face, accessories, outfit colors). Ignore any text, personality notes or speech bubbles on it, and do not copy its layout.';
    const ref = opts.refSheet && fs.existsSync(opts.refSheet) ? opts.refSheet : null;
    refs ??= ref ? [ref] : [];
    const ask = `Use your image generation tool to create this image:\n${prompt}\n${refs.length ? `\n${REF_NOTE}\n` : ''}\nSave the image in the current working directory as out.png. Reply with only the file path.`;
    const timeoutMs = 240000;
    let r;
    const newest = (dir, re = /\.(png|jpe?g|webp)$/i) => {
      if (!dir || !fs.existsSync(dir)) return null;
      const fsn = fs.readdirSync(dir).filter((f) => re.test(f) && !f.startsWith('ref-')).map((f) => path.join(dir, f));
      return fsn.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
    };
    const inJob = () => newest(job);

    if (id === 'gpt') {
      const a = this.cfg.agents.gpt;
      const args = ['exec', ...(this.cfg.codexBaseUrl ? ['-c', `openai_base_url=${JSON.stringify(this.cfg.codexBaseUrl)}`] : []), '-m', photocard ? 'gpt-6-astra' : a.imageModel || 'gpt-6-luna', '-c', `model_reasoning_effort="${photocard ? (opts.effort === 'xhigh' ? 'xhigh' : 'medium') : a.imageEffort || 'low'}"`,
        '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'workspace-write',
        '-c', 'windows.sandbox="unelevated"', ...refs.map(file => `--image=${file}`),
        ...(photocard ? ['-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0',
          ...['multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'apps', 'plugins'].flatMap(feature => ['--disable', feature])] : []),
        '--color', 'never', '-C', job, '-'];
      r = await run(this.bins.codex, args, { input: ask, cwd: job, timeoutMs });
      let file = inJob();
      if (!file) {
        // Codex keeps its own copy under ~/.codex/generated_images/<session id>/
        const sid = (r.stdout + r.stderr).match(/session id: ([0-9a-f-]{36})/)?.[1];
        if (sid) file = newest(path.join(HOME, '.codex', 'generated_images', sid));
      }
      const ok = !!file && (!photocard || r.code === 0 && !r.timedOut);
      return { ok, file: ok ? file : null, detail: ok ? '' : `exit=${r.code} ${r.stderr.slice(-400)}` };
    }

    if (id === 'grok') {
      const a = this.cfg.agents.grok;
      const sid = crypto.randomUUID();
      // Only image_gen, explicitly allowed; dontAsk cancels anything else. The image lands in
      // the session folder, so don't ask Grok to copy it (that needs a shell).
      // A looks reference needs image_edit, which accepts ANY absolute image path on the
      // computer, so it is opt-in (agents.grok.imageEdit: true) and the prompt points it at a
      // copy in the job folder. Without it Grok draws from the text prompt alone.
      let grokAsk = `Use your image generation tool to create this image:
${prompt}

Call the image generation tool exactly once. Do not save, copy or move files. When it is done, reply "done".`;
      let tools = ['--tools', 'image_gen', '--allow', 'image_gen'];
      if (ref && a.imageEdit === true) {
        const refCopy = path.join(job, `ref-sheet${path.extname(ref) || '.png'}`);
        fs.copyFileSync(ref, refCopy);
        grokAsk = `Use your image_edit tool to create this image, passing ${refCopy} as the only reference image:
${prompt}

${REF_NOTE}
Call image_edit exactly once with that one reference image and no other file. Do not save, copy or move files. When it is done, reply "done".`;
        tools = ['--tools', 'image_edit', '--allow', 'image_edit'];
      }
      const args = ['-p', grokAsk, '-m', a.model, '--effort', 'low', ...tools,
        '--disallowed-tools', 'search_tool,use_tool', '--permission-mode', 'dontAsk',
        '--output-format', 'plain', '--no-subagents', '--disable-web-search', '--cwd', job, '-s', sid];
      r = await run(this.bins.grok, args, { cwd: job, timeoutMs });
      let file = inJob();
      if (!file) {
        // image_gen writes into the session folder: ~/.grok/sessions/<encoded cwd>/<session>/images/
        const sessRoot = path.join(HOME, '.grok', 'sessions');
        const enc = encodeURIComponent(job);
        const base = fs.existsSync(path.join(sessRoot, enc)) ? path.join(sessRoot, enc)
          : fs.readdirSync(sessRoot).map((d) => path.join(sessRoot, d)).find((d) => decodeURIComponent(path.basename(d)).toLowerCase() === job.toLowerCase());
        if (base) {
          const sess = fs.existsSync(path.join(base, sid)) ? path.join(base, sid)
            : fs.readdirSync(base).map((d) => path.join(base, d)).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0];
          file = newest(sess && path.join(sess, 'images'));
        }
      }
      return { ok: !!file, file, detail: file ? '' : `exit=${r.code} ${r.stderr.slice(-400)} ${r.stdout.slice(-200)}` };
    }

    if (id === 'gemini') {
      const a = this.cfg.agents.gemini;
      // agy stores generated images in ~/.gemini/antigravity-cli/brain/<conversation>/.
      // Copying them out needs a terminal, which is very slow in --sandbox, so just generate.
      const refName = ref ? `ref-sheet${path.extname(ref) || '.png'}` : null;
      if (ref) fs.copyFileSync(ref, path.join(job, refName));
      const refAsk = ref ? `\nFirst look at ${refName} in the current folder. ${REF_NOTE}\n` : '';
      const geminiAsk = `Use your image generation tool to create this image:\n${prompt}\n${refAsk}\nOnly generate the image. Do not copy, move or save files and do not run any commands. When the image is generated, reply "done".`;
      const args = ['--model', a.imageModel || a.model, '--sandbox', '--dangerously-skip-permissions',
        '--output-format', 'json', '--print-timeout', '220s', '-p', geminiAsk];
      r = await run(this.bins.agy, args, { cwd: job, timeoutMs, env: this.agyEnv() });
      let file = inJob();
      if (!file) {
        try {
          const cid = JSON.parse(r.stdout).conversation_id;
          if (cid) file = newest(path.join(HOME, '.gemini', 'antigravity-cli', 'brain', cid));
        } catch { /* no json */ }
      }
      return { ok: !!file, file, detail: file ? '' : `exit=${r.code} ${r.stderr.slice(-400)}` };
    }

    return { ok: false, detail: 'no image tool' };
  }
}
