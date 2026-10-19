// AI 단톡방 — Claude, ChatGPT, Grok and Gemini chatting in one web room.
// Zero-dependency Node server: static UI + SSE + one independent loop per AI.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setLang, getLang, pick, LANG_DEFAULTS } from './lib/i18n.mjs';
import { Store } from './lib/store.mjs';
import { loadImageAliases } from './lib/image-aliases.mjs';
import { Adapters, killAll, running as runningChildren } from './lib/agents.mjs';
import { UsageMonitor } from './lib/usage.mjs';
import { buildBrief, buildTurn, parseAction, modelLabel } from './lib/prompt.mjs';
import { Router } from './lib/router.mjs';
import { AI_IDS, MEMBERS, DEV, displayName, mentions, atMentions, withJosa } from './lib/members.mjs';
import { personaFor } from './lib/personas.mjs';
import { formatMemberSpeech, takeParticipationTurn } from './lib/member-speech.mjs';
import { efficientConversation, scheduleConversationRead, conversationPriority, BubblePacer } from './lib/conversation-efficiency.mjs';
import { LivingRoom } from './lib/living.mjs';
import { LiarGame } from './lib/liar-game.mjs';
import { LiarSession } from './lib/liar-session.mjs';
import { buildLiarTurn } from './lib/liar-turn.mjs';
import { applyLivingAction, publicLiving, livingText, LIVING_BRIEF, LIVING_CONFLICTS } from './lib/living-integration.mjs';
import { AdminAuth } from './lib/admin-auth.mjs';
import { publicRoom, publicMember, publicMessage, publicPlans, batteryView, sleepStates, publicEvent } from './lib/public-view.mjs';
import { EventHub, WindowLimiter, clientAddress, loopbackAddress, readJsonBody, normalizeBasePath, mountHtml } from './lib/http-limits.mjs';
import { TopicStore, TopicError } from './lib/topics.mjs';
import { deliverTopicMail } from './lib/topic-mail.mjs';
import { proxyAccess } from './lib/proxy-access.mjs';
import { createPublicIdentity, publicId, internalMemberId, resolveCharacterAsset } from './lib/public-identity.mjs';
import { createPublicWorkspace, readPublicPng, PUBLIC_IMAGE_NOTICE } from './lib/public-files.mjs';
import { ImagePreviews } from './lib/image-preview.mjs';
import { DevBridge, devChainState } from './lib/dev.mjs';
import { ExternalGate } from './lib/external.mjs';
import { World } from './lib/world.mjs';
import { PlanBook, PlanError, DEFAULT_PLANNER_CFG } from './lib/plans.mjs';
import { shootWorld } from './lib/worldshot.mjs';
import { saveImageFile } from './lib/image-files.mjs';
import { PhotocardQueue, parsePhotocardRequest, normalizeHomePhotoRequest, resolvePhotocardReferences, buildPhotocardPrompt, photocardWorldSnapshot, photocardLivingSnapshot, HOME_PHOTO_GAP_MS, lastHomePhotoAt, photocardSceneKey } from './lib/photocards.mjs';
import { CozyChatHints, photoSubjectsArriving } from './lib/cozy-chat.mjs';
import { PhotoMoments } from './lib/photo-moments.mjs';
import { RoomRhythm } from './lib/room-rhythm.mjs';
import { HouseholdFlow, leisureRequest, restIntent, enterLeisure, busyHousehold } from './lib/household-flow.mjs';
import { constructionAllowed, availableWorldAction } from './lib/world-actions.mjs';
import koPrompts from './lib/prompts/ko.mjs';
import enPrompts from './lib/prompts/en.mjs';
import jaPrompts from './lib/prompts/ja.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CFG = {
  port: 8321,
  host: '127.0.0.1',
  // ko | en | ja | auto (OS language). Also decides the default roomName / userName.
  language: 'auto',
  roomName: '',
  userName: '',
  admin: { allowedOrigins: [] },
  basePath: '',
  publicOrigin: '',
  publicGateway: false,
  network: { maxClients: 256, perAddress: 128, maxRequests: 64 },
  topics: { enabled: true, sources: [] },
  maxInFlight: 3,
  historyForPrompt: 40,
  autoSleepMinutes: 30,
  speed: 'normal',
  imageGen: true,
  imageCooldownSec: 240,
  constructionEnabled: false,
  // Members may use their CLI's own web search (lib/agents.mjs chat()); nothing that
  // opens arbitrary pages locally.
  webSearch: false,
  planner: { ...DEFAULT_PLANNER_CFG },
  turnTimeoutSec: 150,
  usagePollSec: 120,
  usagePollIdleSec: 600,
  // 진심모드 (per-turn model routing, see lib/router.mjs)
  boost: { mode: 'auto', timeoutSec: 360, selfCooldownSec: 180, aiRequestCooldownSec: 180 },
  // dev bridge (lib/dev.mjs): AI bubbles in the developer reply chain, and dev messages
  // allowed without the user, before the AIs pause until the user speaks
  dev: { enabled: true, replyCap: 6, roundsWithoutUser: 8 },
  // Breaking the silence: after SPEEDS[speed].spark seconds of quiet (or afterSec: [lo, hi]
  // if set) one member is picked; each pass multiplies the next wait by `backoff`, up to maxWaitSec.
  spark: { enabled: true, backoff: 1.25, maxWaitSec: null },
  // Second listener for the owner away from home (lib/external.mjs): password login,
  // no dev bridge API. Off unless config.json turns it on.
  external: { enabled: false, port: 18321, host: '0.0.0.0', https: true },
  // model/effort = default; boost = what a 진심모드 turn overrides (null disables it)
  agents: {
    claude: { model: 'sonnet', boost: { model: 'opus' } },
    gpt: { model: 'gpt-6-sol', effort: 'low', boost: { model: 'gpt-6-astra', effort: 'medium' }, imageModel: 'gpt-6-luna' },
    deepseek: { model: 'deepseek-ai/deepseek-v4.1-flash', maxOutputTokens: 2048, boost: null },
    grok: { model: 'grok-4.7', effort: 'low', boost: { effort: 'high' } },
    gemini: { model: 'gemini-3.8-flash-medium', rotate: 4, boost: { model: 'gemini-3.8-flash-high' } },
  },
};

function loadConfig() {
  let user = {};
  const file = process.env.CHATROOM_CONFIG ? path.resolve(process.env.CHATROOM_CONFIG) : path.join(ROOT, 'config.json');
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Configuration could not be loaded'); }
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('Invalid configuration');
  const cfg = { ...DEFAULT_CFG, ...user, agents: {} };
  cfg.boost = { ...DEFAULT_CFG.boost, ...(user.boost || {}) };
  cfg.dev = { ...DEFAULT_CFG.dev, ...(user.dev || {}) };
  cfg.spark = { ...DEFAULT_CFG.spark, ...(user.spark || {}) };
  cfg.external = { ...DEFAULT_CFG.external, ...(user.external || {}) };
  cfg.planner = { ...DEFAULT_PLANNER_CFG, ...(user.planner || {}) };
  cfg.network = { ...DEFAULT_CFG.network, ...(user.network || {}) };
  for (const key of ['maxClients', 'perAddress', 'maxRequests']) {
    if (!Number.isSafeInteger(cfg.network[key]) || cfg.network[key] < 1 || cfg.network[key] > 1024) throw new Error('Invalid network limits');
  }
  cfg.topics = { ...DEFAULT_CFG.topics, ...(user.topics || {}) };
  cfg.basePath = normalizeBasePath(cfg.basePath);
  if (cfg.publicOrigin) {
    const origin = new URL(cfg.publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== cfg.publicOrigin || origin.username || origin.password) throw new Error('Invalid public origin');
  }
  if (!constructionAllowed(cfg)) cfg.planner.enabled = false;
  // Older configs: ChatGPT-only deepModel / deepMode / deepTimeoutSec.
  if (user.deepMode && !user.boost?.mode) cfg.boost.mode = user.deepMode;
  if (user.deepTimeoutSec && !user.boost?.timeoutSec) cfg.boost.timeoutSec = user.deepTimeoutSec;
  for (const id of AI_IDS) {
    const u = user.agents?.[id] || {};
    const a = { ...DEFAULT_CFG.agents[id], ...u };
    if (!('boost' in u) && u.deepModel) a.boost = { model: u.deepModel, effort: u.deepEffort };
    else if ('boost' in u) a.boost = u.boost ? { ...(DEFAULT_CFG.agents[id].boost || {}), ...u.boost } : null;
    cfg.agents[id] = a;
  }
  // Config files written before the language setting existed all belong to Korean rooms.
  cfg.language = setLang(user.language ?? (Object.keys(user).length ? 'ko' : 'auto'));
  cfg.roomName = cfg.roomName || LANG_DEFAULTS[cfg.language].roomName;
  cfg.userName = cfg.userName || LANG_DEFAULTS[cfg.language].userName;
  return cfg;
}

const cfg = loadConfig();
if (cfg.publicGateway && (!cfg.publicOrigin || (process.env.CHATROOM_PROXY_TOKEN || '').length < 32)) {
  throw new Error('Public gateway configuration is incomplete');
}
// CHATROOM_HOME moves data/ and workspace/ elsewhere (a separate room, or tests); CHATROOM_CONFIG
// points at another config file; PORT overrides the port.
const HOME_DIR = process.env.CHATROOM_HOME ? path.resolve(process.env.CHATROOM_HOME) : ROOT;
if (process.env.PORT) cfg.port = Number(process.env.PORT);
const store = new Store(HOME_DIR);
const imageAliases = loadImageAliases(HOME_DIR);
const publicIdentity = createPublicIdentity(cfg);
const publicWorkspace = createPublicWorkspace(store, publicIdentity, imageAliases);
const imagePreviews = new ImagePreviews(path.join(HOME_DIR, 'data', 'image-previews-v1'));
const addressOf = req => clientAddress(req, { secret: process.env.CHATROOM_PROXY_TOKEN, header: 'x-chatroom-client-ip' });
const admin = new AdminAuth(HOME_DIR, { allowedOrigins: [
  `http://localhost:${cfg.port}`, `http://127.0.0.1:${cfg.port}`,
  ...(Array.isArray(cfg.admin?.allowedOrigins) ? cfg.admin.allowedOrigins : []),
  ...(cfg.publicOrigin ? [cfg.publicOrigin] : []),
], cookiePath: cfg.basePath + '/', loginAddress: addressOf });
const topics = new TopicStore(HOME_DIR, cfg.topics);
const readLimit = new WindowLimiter({ limit: 1200, windowMs: 60000, maxKeys: 1024 });
const totalReadLimit = new WindowLimiter({ limit: 6000, windowMs: 60000, maxKeys: 1 });
const submitLimit = new WindowLimiter({ limit: 5, windowMs: 10 * 60000, maxKeys: 1024 });
const totalSubmitLimit = new WindowLimiter({ limit: 30, windowMs: 60 * 60000, maxKeys: 1 });
let activeRequests = 0, shuttingDown = false, lastTopicImport = 0;
const adapters = new Adapters(HOME_DIR, cfg);
// Shared building world (lib/world.mjs), watched in public/world.html.
const world = new World(HOME_DIR, AI_IDS);
let living = null;
try { living = new LivingRoom(HOME_DIR, { members: AI_IDS }); }
catch { console.error('Living state could not be loaded; existing data was preserved.'); }
const plans = new PlanBook(HOME_DIR, cfg, world, (prompt) => adapters.plan(prompt));
const avail = adapters.available();

// Dev bridge: the development session joins the room as "개발자" (lib/dev.mjs).
const devBridge = new DevBridge(HOME_DIR, {
  store,
  cfg,
  post: (m) => post(m),
  roomView: () => roomView(),
  fileChanged: (r) => {
    post({ from: 'system', kind: 'file', by: DEV.id, file: r.op === 'delete' ? undefined : r.rel, text: `${DEV.name} → ${r.rel} ${tx().verb[r.op] || r.op}` });
    broadcast('ws', store.listFiles());
  },
  onPresence: (online) => {
    post({ from: 'system', kind: 'dev', by: DEV.id, online, text: online ? tx().devIn() : tx().devOut() });
    pushRoom();
  },
});

// Pacing presets. Seconds. `spark`: how long the room stays quiet before one member is
// picked to break the silence (see maybeSpark).
const SPEEDS = {
  slow: { read: [25, 50], hostRead: [12, 22], batchMax: 75, bubbleGap: 12, idle: [160, 320], spark: [140, 220], sparkMax: 330, cooldown: 35, perMin: 4, typing: 1.8 },
  normal: { read: [12, 24], hostRead: [7, 13], batchMax: 55, bubbleGap: 7, idle: [70, 150], spark: [65, 115], sparkMax: 165, cooldown: 15, perMin: 7, typing: 1.3 },
  fast: { read: [5, 12], hostRead: [3, 7], batchMax: 40, bubbleGap: 4, idle: [40, 80], spark: [35, 65], sparkMax: 110, cooldown: 7, perMin: 12, typing: 0.9 },
};

// ---------------------------------------------------------------------------
// Room + per-AI runtime state

const room = (store.state.room ??= {});
room.running ??= false;
room.sleeping ??= false;
room.speed ??= cfg.speed;
room.boostMode ??= cfg.boost.mode;
room.autoSleepMin ??= cfg.autoSleepMinutes;
room.enabled ??= {};
for (const id of AI_IDS) room.enabled[id] ??= true;
room.lastUserAt = Date.now();
room.calls ??= 0;
store.state.seen ??= {};
try { if (room.running && !room.sleeping) living?.resume(); else living?.pause(); }
catch { living = null; console.error('Living clock could not be restored.'); }

const agents = {};
let photocardQueue = null;
let liarPrivateGuess = false;
const cozyChatHints = new CozyChatHints();
const photoMoments = new PhotoMoments();
const roomRhythm = new RoomRhythm();
const householdFlow = new HouseholdFlow(store.state.householdFlow);
const bubblePacer = new BubblePacer(store.recent(40).findLast(m => AI_IDS.includes(m.from) && m.text)?.ts ?? -Infinity);
for (const id of AI_IDS) {
  agents[id] = {
    id, busy: false, status: 'idle', seen: store.state.seen[id] ?? store.lastId,
    wakeAt: null, reason: null, readBatch: null, idleAt: null, idleStreak: 0, lastEnd: 0,
    fails: 0, offlineUntil: 0, lastError: '', imageBusy: false, lastImageAt: 0, calls: 0, lastMs: 0,
    callTimes: [], lastSelfBoostAt: 0, deepNow: false,
    participationCredit: efficientConversation(id, cfg) ? 1 - (cfg.agents[id]?.participation || 1) : 0,
  };
}

let saveTimer = null;
function saveSoon() {
  if (shuttingDown) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const id of AI_IDS) store.state.seen[id] = agents[id].seen;
    store.state.householdFlow = householdFlow.snapshot();
    store.saveState();
  }, 500);
}

const isActive = (id) => room.enabled[id] && avail[id];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = (id) => displayName(id, cfg.userName);
const nameJ = (id, pair) => withJosa(id, cfg.userName, pair);

// Room texts per language: system messages, API errors, notes handed to the members and
// console lines. Read with tx() at use time. Korean keeps its particles (nameJ / withJosa);
// English and Japanese use the plain name.
const T = {
  ko: {
    devIn: () => `🛠 ${DEV.name} 들어옴 (개발 세션 연결)`,
    devOut: () => `🛠 ${DEV.name} 나감`,
    devPause: (why) => `⏸ ${why} 쌓여서 ${withJosa(cfg.userName, cfg.userName, '이/가')} 말할 때까지 다들 잠깐 쉬어`,
    boostOn: (id, model, why) => `🔥 ${name(id)} 진심모드 — ${model} · ${why}`,
    boostFail: (id, timeout) => `${name(id)} 진심모드가 ${timeout ? '너무 오래 걸려서' : '실패해서'} 기본 모델로 답할게`,
    selfBoost: (why) => `스스로 판단: ${why}`,
    shotBlind: '(월드 스크린샷을 찍었는데 너한텐 사진이 안 보여)',
    worldMap: '건축 월드 지도',
    cut: (n) => `\n…(${n}자 잘림)`,
    autoDesc: (d) => `자동 설명: ${d}`,
    artistPrompt: (p) => `그린 사람이 쓴 프롬프트: ${p}`,
    noDesc: '설명 없음',
    blindImage: (about) => `(그림 파일이라 너한텐 직접 안 보여. ${about})`,
    verb: { create: '새로 만듦', write: '다시 씀', append: '내용 추가', edit: '수정', delete: '삭제' },
    fileFail: (id, err) => `${name(id)}의 파일 작업 실패: ${err}`,
    showMissing: (id, rel) => `${nameJ(id, '이/가')} 첨부 파일을 찾을 수 없습니다: ${rel}`,
    newBlock: (id, n) => `🎨 ${name(id)} → 새 블록 ${n} 만듦`,
    blockFail: (id, err) => `${name(id)}의 블록 만들기: ${err}`,
    buildNotes: (id, notes) => `${name(id)}의 건축: ${notes}`,
    stickerSaved: (id, rel) => `${name(id)} → ${rel} 스티커로 저장 완료`,
    stickerFail: (id, err) => `${name(id)}의 스티커 저장 실패: ${err}`,
    noImage: (rel) => `없는 그림 ${rel}`,
    stickerPath: '저장 경로는 stickers/멤버/이름.png 식이어야 해',
    stickerExt: '확장자가 원본이랑 같아야 해',
    fileLimit: '파일 개수 한도',
    cameraLift: (id, x, y, z, fy) => `📸 ${name(id)} 카메라 위치 (${x},${y},${z})를 (${x},${fy},${z})로 조정했습니다`,
    shotFail: (id, err) => `${name(id)}의 월드 스크린샷 실패: ${err}`,
    cantDraw: (id, busy, sec) => `${nameJ(id, '은/는')} 아직 그림을 못 그려 (${busy ? '그리는 중' : `${sec}초 뒤 가능`})`,
    drawing: (id) => `🎨 ${name(id)} 그림 그리는 중…`,
    photographing: (id) => `📸 ${name(id)} 생활 사진 만드는 중…`,
    drawFail: (id) => `${name(id)}의 그림 생성 실패`,
    slept: () => `💤 ${withJosa(cfg.userName, cfg.userName, '이/가')} 한동안 조용해서 다들 잠들었어. 말 걸면 깨어나.`,
    imgEmpty: '이미지가 비어 있습니다',
    imgTooBig: (mb) => `이미지는 ${mb}MB까지 첨부할 수 있습니다`,
    imgType: 'PNG, JPG, GIF, WEBP 이미지만 첨부할 수 있습니다',
    imgLimit: '작업공간의 파일 개수 한도에 도달했습니다',
    tooLarge: '요청 내용이 너무 큽니다',
    noSticker: '스티커를 찾을 수 없습니다',
    boostWho: '진심모드를 사용할 멤버를 지정해 주세요. 예: /boost @아디나',
    boostOff: '진심모드가 비활성화되어 있습니다. 방 설정에서 활성화해 주세요.',
    boostNone: '해당 멤버의 진심모드가 설정되지 않았습니다',
    boostArmed: (names) => `⚡ ${withJosa(cfg.userName, cfg.userName, '이/가')} ${names} 진심모드를 켰어 (다음 턴)`,
    joined: (id) => `${name(id)} 들어옴`,
    left: (id) => `${name(id)} 잠깐 나감`,
    sep: ', ',
    welcome: (members) => `${withJosa(cfg.roomName, cfg.userName, '이/가')} 열렸어. 멤버: ${members}, 그리고 ${cfg.userName}.`,
    extPortFail: (err) => `외부 접속 포트를 못 열었어: ${err}`,
    extOn: (proto, port) => `외부 접속 → ${proto}://<공인 IP>:${port} (비밀번호: data/external-password.txt)`,
    extFail: (err) => `외부 접속을 못 켰어: ${err}`,
    portBusy: (port, code) => `포트 ${port}을(를) 못 열었어 (${code}). 방이 이미 켜져 있거나, 다른 프로그램이 쓰거나, 막힌 포트야.`,
    portHint: 'config.json의 "port"를 바꾸거나 setup(setup.bat / ./setup.sh)을 다시 실행해서 빈 포트를 골라 줘.',
    listening: (url) => `ERCraft 단톡방 → ${url}`,
    cliMissing: (list) => `찾을 수 없는 CLI: ${list} (그 멤버는 오프라인)`,
    cliHint: '설치·로그인은 setup.bat(Windows) / ./setup.sh(macOS·Linux)가 도와줘.',
  },
  en: {
    devIn: () => `🛠 ${DEV.name} joined (dev session connected)`,
    devOut: () => `🛠 ${DEV.name} left`,
    devPause: (why) => `⏸ ${why}, so everyone's taking a break until ${cfg.userName} says something`,
    boostOn: (id, model, why) => `🔥 ${name(id)} Boost mode — ${model} · ${why}`,
    boostFail: (id, timeout) => `${name(id)}'s Boost mode ${timeout ? 'took too long' : 'failed'}, so it's answering with the default model`,
    selfBoost: (why) => `self-requested: ${why}`,
    shotBlind: "(You took a world screenshot, but you can't see pictures.)",
    worldMap: 'Build World map',
    cut: (n) => `\n…(${n} more characters cut)`,
    autoDesc: (d) => `Auto description: ${d}`,
    artistPrompt: (p) => `Prompt the artist used: ${p}`,
    noDesc: 'No description',
    blindImage: (about) => `(It's a picture, so you can't see it directly. ${about})`,
    verb: { create: 'created', write: 'rewritten', append: 'appended', edit: 'edited', delete: 'deleted' },
    fileFail: (id, err) => `${name(id)}'s file operation failed: ${err}`,
    showMissing: (id, rel) => `${name(id)} tried to show ${rel}, but that file doesn't exist`,
    newBlock: (id, n) => `🎨 ${name(id)} → made a new block ${n}`,
    blockFail: (id, err) => `${name(id)} couldn't make the block: ${err}`,
    buildNotes: (id, notes) => `${name(id)}'s build: ${notes}`,
    stickerSaved: (id, rel) => `${name(id)} → saved ${rel} as a sticker`,
    stickerFail: (id, err) => `${name(id)} couldn't save the sticker: ${err}`,
    noImage: (rel) => `No such image ${rel}`,
    stickerPath: 'The save path must look like stickers/member/name.png',
    stickerExt: 'The extension must match the original',
    fileLimit: 'File limit reached',
    cameraLift: (id, x, y, z, fy) => `📸 ${name(id)}'s camera spot (${x},${y},${z}) is inside a block, so it moves up to (${x},${fy},${z}) for the shot`,
    shotFail: (id, err) => `${name(id)}'s world screenshot failed: ${err}`,
    cantDraw: (id, busy, sec) => `${name(id)} can't draw yet (${busy ? 'still drawing' : `ready in ${sec}s`})`,
    drawing: (id) => `🎨 ${name(id)} is drawing…`,
    photographing: (id) => `📸 ${name(id)} is creating a snapshot…`,
    drawFail: (id) => `${name(id)}'s image generation failed`,
    slept: () => `💤 Everyone dozed off since ${cfg.userName} went quiet. Say something to wake them up.`,
    imgEmpty: 'The image is empty',
    imgTooBig: (mb) => `Images can be up to ${mb}MB`,
    imgType: 'Only PNG, JPG, GIF and WEBP images can be uploaded',
    imgLimit: "The Workspace is at its file limit, so the image can't be uploaded",
    tooLarge: 'That was too big to send',
    noSticker: "That sticker doesn't exist",
    boostWho: 'Say who to put in Boost mode, e.g. /boost @Grok take a look at this',
    boostOff: 'Boost mode is off. Turn it on in the room settings.',
    boostNone: "That member doesn't have Boost mode settings",
    boostArmed: (names) => `⚡ ${cfg.userName} turned on Boost mode for ${names} (next turn)`,
    joined: (id) => `${name(id)} joined`,
    left: (id) => `${name(id)} stepped out for a bit`,
    sep: ', ',
    welcome: (members) => `${cfg.roomName} is open. Members: ${members}, and ${cfg.userName}.`,
    extPortFail: (err) => `Couldn't open the external access port: ${err}`,
    extOn: (proto, port) => `External access → ${proto}://<public IP>:${port} (password: data/external-password.txt)`,
    extFail: (err) => `Couldn't turn on external access: ${err}`,
    portBusy: (port, code) => `Couldn't open port ${port} (${code}). The room may already be running, another program may be using it, or the port is blocked.`,
    portHint: 'Change "port" in config.json, or run setup again (setup.bat / ./setup.sh) to pick a free port.',
    listening: (url) => `AI Group Chat → ${url}`,
    cliMissing: (list) => `CLI not found: ${list} (those members stay offline)`,
    cliHint: 'setup.bat (Windows) / ./setup.sh (macOS, Linux) helps with installing and logging in.',
  },
  ja: {
    devIn: () => `🛠 ${DEV.name}が入ってきた(開発セッション接続)`,
    devOut: () => `🛠 ${DEV.name}が抜けた`,
    devPause: (why) => `⏸ ${why}から、${cfg.userName}が話すまでみんなちょっと休憩ね`,
    boostOn: (id, model, why) => `🔥 ${name(id)} 本気モード — ${model} · ${why}`,
    boostFail: (id, timeout) => `${name(id)}の本気モードが${timeout ? '時間かかりすぎた' : '失敗した'}から、いつものモデルで答えるね`,
    selfBoost: (why) => `自分で判断: ${why}`,
    shotBlind: '(ワールドのスクショを撮ったけど、自分には画像が見えない)',
    worldMap: '建築ワールドの地図',
    cut: (n) => `\n…(${n}文字省略)`,
    autoDesc: (d) => `自動説明: ${d}`,
    artistPrompt: (p) => `描いた人が書いたプロンプト: ${p}`,
    noDesc: '説明なし',
    blindImage: (about) => `(画像ファイルだから自分には直接見えない。${about})`,
    verb: { create: '新規作成', write: '書き直し', append: '追記', edit: '修正', delete: '削除' },
    fileFail: (id, err) => `${name(id)}のファイル操作が失敗: ${err}`,
    showMissing: (id, rel) => `${name(id)}が見せようとした ${rel} ってファイルはないよ`,
    newBlock: (id, n) => `🎨 ${name(id)} → 新しいブロック ${n} を作った`,
    blockFail: (id, err) => `${name(id)}のブロック作り: ${err}`,
    buildNotes: (id, notes) => `${name(id)}の建築: ${notes}`,
    stickerSaved: (id, rel) => `${name(id)} → ${rel} をスタンプに保存`,
    stickerFail: (id, err) => `${name(id)}のスタンプ保存が失敗: ${err}`,
    noImage: (rel) => `画像 ${rel} がない`,
    stickerPath: '保存先は stickers/メンバー/名前.png の形にして',
    stickerExt: '拡張子は元のファイルと同じにして',
    fileLimit: 'ファイル数の上限',
    cameraLift: (id, x, y, z, fy) => `📸 ${name(id)}のカメラ位置 (${x},${y},${z}) がブロックの中だから、(${x},${fy},${z}) まで上げて撮るね`,
    shotFail: (id, err) => `${name(id)}のワールドのスクショが失敗: ${err}`,
    cantDraw: (id, busy, sec) => `${name(id)}はまだ絵を描けない(${busy ? '描いてる途中' : `あと${sec}秒`})`,
    drawing: (id) => `🎨 ${name(id)}が絵を描いてる…`,
    photographing: (id) => `📸 ${name(id)}が日常の写真を作成中…`,
    drawFail: (id) => `${name(id)}の画像生成が失敗`,
    slept: () => `💤 ${cfg.userName}がしばらく静かだったから、みんな寝ちゃった。話しかければ起きるよ。`,
    imgEmpty: '画像が空っぽだよ',
    imgTooBig: (mb) => `画像は${mb}MBまでだよ`,
    imgType: 'アップできるのはPNG、JPG、GIF、WEBPの画像だけだよ',
    imgLimit: 'ワークスペースのファイル数が上限だからアップできない',
    tooLarge: '送った内容が大きすぎる',
    noSticker: 'そのスタンプはないよ',
    boostWho: '誰を本気モードにするか書いて。例: /boost @Grok これ見て',
    boostOff: '本気モードがオフになってる。ルーム設定でオンにして。',
    boostNone: 'そのメンバーには本気モードの設定がないよ',
    boostArmed: (names) => `⚡ ${cfg.userName}が${names}の本気モードをオンにした(次のターン)`,
    joined: (id) => `${name(id)}が入ってきた`,
    left: (id) => `${name(id)}がちょっと抜けた`,
    sep: '、',
    welcome: (members) => `${cfg.roomName}がオープンしたよ。メンバー: ${members}、それと${cfg.userName}。`,
    extPortFail: (err) => `外部アクセス用のポートを開けなかった: ${err}`,
    extOn: (proto, port) => `外部アクセス → ${proto}://<グローバルIP>:${port} (パスワード: data/external-password.txt)`,
    extFail: (err) => `外部アクセスをオンにできなかった: ${err}`,
    portBusy: (port, code) => `ポート${port}を開けなかった(${code})。ルームがもう動いてるか、ほかのプログラムが使ってるか、ブロックされてるポートだよ。`,
    portHint: 'config.jsonの"port"を変えるか、setup(setup.bat / ./setup.sh)をもう一回実行して空いてるポートを選んで。',
    listening: (url) => `AIグループチャット → ${url}`,
    cliMissing: (list) => `見つからないCLI: ${list} (そのメンバーはオフライン)`,
    cliHint: 'インストールとログインは setup.bat (Windows) / ./setup.sh (macOS・Linux) が手伝ってくれるよ。',
  },
};
const tx = () => pick(T);

// ---------------------------------------------------------------------------
// SSE

const eventHub = new EventHub(cfg.network);
const clients = eventHub.clients;
const clientAuth = new WeakMap();
function refreshClientSession(c) {
  const info = clientAuth.get(c);
  if (!info) return;
  const session = admin.session(info.req);
  if (session.role !== info.role) {
    info.role = session.role;
    eventHub.write(c, `event: session\ndata: ${JSON.stringify(session)}\n\n`);
  }
}
function broadcast(type, data) {
  if (type === 'usage') return;
  if (type === 'ws') data = publicFiles();
  data = publicEvent(type, data, getLang(), publicIdentity, publicWorkspace.publicPath);
  if (data === null) return;
  const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.keys()) { refreshClientSession(c); eventHub.write(c, s); }
}
setInterval(() => { for (const c of clients.keys()) { refreshClientSession(c); eventHub.write(c, ': ping\n\n'); } }, 25000);

function memberView(id) {
  const persona = personaFor(id);
  const a = agents[id];
  let status = a.status;
  if (!avail[id]) status = 'missing';
  else if (!room.enabled[id]) status = 'off';
  else if (!room.running && !a.busy) status = room.sleeping ? 'sleeping' : 'away';
  else if (Date.now() < a.offlineUntil) status = 'error';
  else if (!a.busy && householdFlow.phase(id) === 'sleep') status = 'sleeping';
  else if (!a.busy && householdFlow.phase(id) === 'rest') status = 'away';
  if (liarPrivateGuess && ['reading', 'typing'].includes(status)) status = 'idle';
  return {
    id, name: MEMBERS[id].name, maker: MEMBERS[id].maker, color: MEMBERS[id].color,
    accentColor: MEMBERS[id].accentColor || MEMBERS[id].color,
    aliases: MEMBERS[id].aliases || [], legacyAliases: MEMBERS[id].legacyAliases || [],
    persona: persona ? { name: persona.name, skin: personaSkin(id, persona.skin), look: persona.look } : null,
    imageVision: adapters.canSee(id),
    model: cfg.agents[id].model, imageGen: MEMBERS[id].imageGen && cfg.imageGen,
    status, drawing: a.imageBusy, enabled: room.enabled[id], available: avail[id],
    calls: a.calls, lastMs: a.lastMs, lastError: a.lastError,
    deep: !!a.deepNow, defaultModel: defaultLabel(id), boostModel: hasBoost(id) ? boostLabel(id) : null,
  };
}
function roomView() {
  return {
    running: room.running, sleeping: room.sleeping, speed: room.speed, autoSleepMin: room.autoSleepMin,
    calls: room.calls, roomName: cfg.roomName, userName: cfg.userName, lang: getLang(), boostMode: boostMode(),
    dev: { online: devBridge.online },
  };
}
function pushMembers() { const members = AI_IDS.map(memberView); broadcast('members', members); broadcast('sleeps', sleepStates(members)); }
function pushRoom() { broadcast('room', roomView()); broadcast('sleeps', sleepStates(AI_IDS.map(memberView))); }
function setStatus(a, status) {
  if (a.status === status) return;
  a.status = status;
  pushMembers();
}

function post(m) {
  const msg = store.addMessage(m);
  broadcast('msg', msg);
  devBridge.notify(msg);
  return msg;
}

function react(targetId, by, emoji) {
  const msg = store.applyReaction(targetId, by, emoji);
  if (msg) broadcast('msgupdate', msg);
}

// ---------------------------------------------------------------------------
// Scheduler

const liarMember = actor => AI_IDS.find(id => publicId(id) === actor);
const liarRunning = () => !shuttingDown && room.running && !room.sleeping
  && !(room.autoSleepMin > 0 && Date.now() - room.lastUserAt > room.autoSleepMin * 60000);
const liarAvailable = () => AI_IDS.every(id => isActive(id) && Date.now() >= agents[id].offlineUntil);
let liarEngine = null;
try { liarEngine = new LiarGame(HOME_DIR); }
catch { console.error('Liar game state could not be loaded; existing data was preserved.'); }
const liarSession = new LiarSession(liarEngine, {
  canRun: () => liarRunning() && liarAvailable(),
  async call(actor, context) {
    const id = liarMember(actor), a = agents[id];
    a.busy = true; a.wakeAt = null; a.reason = null; a.readBatch = null;
    a.calls++; room.calls++;
    a.callTimes = a.callTimes.filter(at => Date.now() - at < 3600000);
    a.callTimes.push(Date.now());
    setStatus(a, 'reading'); pushRoom(); pushUsageSoon(); saveSoon();
    const { brief, turn } = buildLiarTurn(id, { ...context, currentActivity: householdFlow.phase(id) }, getLang());
    const result = await adapters.chat(id, brief, turn, { game: true, boost: false, images: [] });
    a.lastMs = result.ms;
    store.log(id, `liar phase=${context.phase} ms=${result.ms} ok=${!!result.ok}`);
    if (!result.ok) a.offlineUntil = Date.now() + 60000;
    return result;
  },
  prepare: (actor, text) => formatMemberSpeech(liarMember(actor), text),
  async beforeSubmit(actor, text) {
    setStatus(agents[liarMember(actor)], 'typing');
    await sleep(typingDelay(text));
    await bubblePacer.wait({ active: liarRunning,
      gapMs: () => (SPEEDS[room.speed] || SPEEDS.normal).bubbleGap * 1000, sleep });
  },
  speech({ actor, text }) {
    const id = liarMember(actor);
    // Only accepting a public speaking turn ends this resident's optional break.
    // An invitation or a decline alone must not clear anyone's rest state.
    if (householdFlow.interrupt(id)) { saveSoon(); pushMembers(); }
    post({ from: id, text, kind: 'chat' });
  },
  notice(text) {
    if (text === '이번 라이어 게임이 끝났습니다. 결과를 확인해 주세요.') {
      const result = liarSession.view().round?.result;
      if (result?.word && result.liar) text = `라이어 게임 결과: ${result.outcome === 'draw' ? '무승부' : result.outcome === 'citizens' ? '시민 승리' : '라이어 승리'}! 라이어는 ${name(liarMember(result.liar))}, 제시어는 ‘${result.word}’였습니다.${result.guess ? ` 마지막 추측은 ‘${result.guess}’였습니다.` : ''}`;
    }
    post({ from: 'system', kind: 'info', text });
  },
  change(view) {
    const hide = view.round?.status === 'active' && view.round.phase === 'guess';
    if (hide !== liarPrivateGuess) { liarPrivateGuess = hide; pushMembers(); }
    broadcast('liar', view);
  },
  settled(actor) {
    const a = agents[liarMember(actor)];
    a.busy = false; a.lastEnd = Date.now();
    setStatus(a, 'idle'); saveSoon();
  },
  onError: () => console.error('Liar game stopped safely; existing data was preserved.'),
  onDiagnostic: ({ reason, phase }) => store.log('system', `liar rejected phase=${phase} reason=${reason}`),
});

function tick() {
  roomRhythm.observe(world, { active: !shuttingDown && room.running && !room.sleeping });
  if (!shuttingDown && !liarRunning()) liarSession.tick({ running: false, available: false, busy: false });
  if (shuttingDown || !room.running || room.sleeping) return;
  const now = Date.now();
  if (householdFlow.expire(now)) { saveSoon(); pushMembers(); }
  if (now - lastTopicImport >= 60000) { lastTopicImport = now; topics.importLocal(cfg.topics.sources); }
  if (room.autoSleepMin > 0 && now - room.lastUserAt > room.autoSleepMin * 60000) {
    sleepRoom();
    return;
  }
  // Advance deterministic household timers on the existing tick, without model calls.
  if (living) {
    try {
      const update = living.advance(now);
      if (update.changed) {
        broadcast('living', publicLiving(living.view(), publicIdentity));
        if (update.text) post({ from: 'system', kind: 'world', text: livingText(update.text) });
      }
    } catch {
      living = null;
      broadcast('living', { unavailable: true });
      console.error('Living state update failed; existing data was preserved.');
    }
  }
  const householdGame = living?.view().game;
  const gameBusy = Object.values(agents).some(a => a.busy || a.imageBusy)
    || !!householdGame && householdGame.status !== 'finished';
  if (liarSession.tick({ running: liarRunning(), available: liarAvailable(), busy: gameBusy })) return;
  // Once due, let existing work drain instead of continually adding new chat turns.
  // An already running household board game still needs ordinary turns to finish.
  if (liarSession.view().nextStartAt <= now && (!householdGame || householdGame.status === 'finished')) return;
  // Explicitly volunteered work never wakes a stopped room or postpones auto-sleep.
  continuePlan(now);
  processPlanQueue();
  const sp = SPEEDS[room.speed] || SPEEDS.normal;
  let inflight = AI_IDS.filter((id) => agents[id].busy && !agents[id].pacing).length;
  const last = store.lastMessage();
  const quietMs = now - Math.max(last?.ts ?? 0, room.startedAt ?? 0);
  const aiBubbles = store.recent(60).filter((m) => AI_IDS.includes(m.from) && now - m.ts < 60000).length;
  // Dev <-> AI back-and-forth guard: while it holds, only the user's messages wake the AIs.
  const chain = cfg.dev.enabled ? devChainState(store.recent(80), now, { ...cfg.dev, userName: cfg.userName }) : null;
  noteDevPause(chain);
  if (!chain) maybeSpark(now, sp);

  for (const id of shuffle([...AI_IDS])) {
    const a = agents[id];
    if (!isActive(id)) { a.readBatch = null; continue; }
    if (a.busy || now < a.offlineUntil) continue;

    const fresh = store.after(a.seen).filter((m) => m.from !== id && !m.continuation);
    const directHostPending = fresh.some(m => m.from === 'user' && isCalled(m,id));
    const peerCalled = fresh.some(m => AI_IDS.includes(m.from) && isCalled(m,id));
    if (householdFlow.blocks(id,{directHost:directHostPending,peerCalled,now})) {
      // A resident's break consumes notifications, never history. Do not replay old goodnights later.
      if (a.seen !== store.lastId) { a.seen = store.lastId; saveSoon(); }
      a.wakeAt = null; a.reason = null; a.readBatch = null;
      if (spark.who === id) spark.who = null;
      continue;
    }
    if ((directHostPending || peerCalled) && householdFlow.phase(id,now) && householdFlow.interrupt(id)) { saveSoon(); pushMembers(); }
    if (chain && !fresh.some((m) => m.from === 'user')) {
      a.wakeAt = null;
      a.readBatch = null;
      continue;
    }
    if (!adapters.canSee(id) && waitingForDesc(fresh, now)) continue;
    if (!fresh.length) a.readBatch = null;
    if (fresh.length) {
      a.idleStreak = 0;
      a.idleAt = null;
      const urgent = fresh.some((m) => isCalled(m, id));
      const directHost = fresh.some(m => m.from === 'user' && isCalled(m, id));
      if (id === 'gemini') {
        scheduleGeminiRead(a, fresh, now, urgent);
      } else if (efficientConversation(id, cfg)) {
        scheduleConversationRead(a, fresh, now, { urgent,
          directHost, hostDelayMs: rand(...sp.hostRead) * 1000,
          quietDelayMs: Math.max(15000, rand(...sp.read) * 1000), maxWaitMs: sp.batchMax * 1000 });
      } else if (!a.wakeAt || directHost || (urgent && a.reason !== 'urgent')) {
        const [lo, hi] = directHost ? sp.hostRead : sp.read;
        a.wakeAt = Math.min(a.wakeAt ?? Infinity, now + rand(lo, hi) * 1000);
        a.reason = urgent ? 'urgent' : 'new';
      }
    } else if (!a.wakeAt && !sparkOn()) {
      // Old quiet-time behaviour (spark off): everyone gets their own idle turn.
      a.idleAt ??= now + rand(...sp.idle) * 1000 * Math.pow(1.7, Math.min(a.idleStreak, 5));
      if (now >= a.idleAt && quietMs > sp.idle[0] * 500) {
        a.wakeAt = now;
        a.reason = 'idle';
      }
    }

    if (!a.wakeAt || now < a.wakeAt) continue;
    // A silence turn must yield if real conversation or world work began after
    // selection. Normal replies and direct host requests keep their own pacing.
    if (a.reason === 'spark' && (a.imageBusy || sparkWorldBusy() || AI_IDS.some(other => other !== id
      && (agents[other].busy || agents[other].wakeAt || agents[other].imageBusy)))) continue;
    if (now - a.lastEnd < sp.cooldown * 1000) continue;
    if (inflight >= cfg.maxInFlight) continue;
    const conversationTurn = efficientConversation(id, cfg) && conversationPriority(a, now, {
      peerCalled: fresh.some(m => AI_IDS.includes(m.from) && isCalled(m, id)),
      peerUnread: fresh.some(m => AI_IDS.includes(m.from)),
    });
    if (!fresh.some(m => m.from === 'user' && isCalled(m, id)) && !conversationTurn && aiBubbles >= sp.perMin) continue;
    if (a.reason === 'idle' && AI_IDS.some((o) => agents[o].busy && agents[o].turnReason === 'idle')) {
      a.wakeAt = null;
      a.idleAt = now + 15000;
      continue;
    }
    const directHostRequest = fresh.some((m) => m.from === 'user' && isCalled(m, id));
    if (conversationTurn && !directHostRequest) {
      const rate = cfg.agents[id]?.participation;
      const share = Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : 1;
      a.participationCredit = Math.max(0, (a.participationCredit || 0) + share - 1);
    }
    if (!conversationTurn && !takeParticipationTurn(a, cfg.agents[id]?.participation, directHostRequest)) {
      // Consume this notification once; the next tick must not retry the same
      // skipped opportunity. History itself remains available for the next turn.
      a.seen = store.lastId;
      a.wakeAt = null;
      a.reason = null;
      a.readBatch = null;
      a.idleAt = now + rand(...sp.idle) * 1000;
      if (spark.who === id) { spark.who = null; spark.lastBy = id; }
      saveSoon();
      continue;
    }
    inflight++;
    if (conversationTurn) a.reason = 'urgent';
    runTurn(a);
  }
  if (world.home?.id === 'mulgyeol-maru') {
    const photoBusy = !!(photocardQueue?.active || photocardQueue?.pending.length || AI_IDS.some(id=>agents[id].busy||agents[id].imageBusy));
    const eligible = AI_IDS.filter(id=>isActive(id) && now>=agents[id].offlineUntil && !householdFlow.phase(id,now)
      && (!agents[id].wakeAt || agents[id].wakeAt-now>12000)
      && !store.after(agents[id].seen).some(m=>m.from==='user'&&isCalled(m,id)));
    const step = roomRhythm.ambientStep(world,{eligible,living:living?.view(),photoBusy,now});
    if (step && world.move(step.actor,step.point)) broadcast('avatars',world.avatarView());
  }
}

// Coalesce peer bursts without consuming unread messages or delaying a host request.
// Only a new message advances the quiet timer; the first deadline never moves.
function scheduleGeminiRead(a, fresh, now, urgent) {
  const directHost = fresh.some(m => m.from === 'user' && isCalled(m, a.id));
  const sp = SPEEDS[room.speed] || SPEEDS.normal;
  scheduleConversationRead(a, fresh, now, { directHost, urgent,
    hostDelayMs: rand(...sp.hostRead) * 1000, quietDelayMs: rand(...sp.read) * 1000,
    maxWaitMs: sp.batchMax * 1000 });
}

// ---- Breaking the silence ----
// When nobody has said anything for a while, every member used to get its own idle turn,
// and each one passed, waiting for someone else (bystander effect). Now one member at a
// time is picked, told it is its turn to start something, and given ideas that come from
// the room itself (its own "하고 싶은 것" notes, the time of day, a random card), never
// from the user. If it passes, the next pick waits longer.

const spark = { base: null, streak: 0, wait: null, lastEnd: 0, lastBy: null, who: null, quick: false };
const sparkOn = () => cfg.spark.enabled !== false;

function sparkWorldBusy() {
  if (!constructionAllowed(cfg)) return false;
  return continuationBusy || !!plans.state?.inflight || (plans.state?.plans || []).some(p => p.pending
    || p.continuation && !p.continuation.paused && ['draft', 'building'].includes(p.status));
}

function lastSaid(id) {
  for (let i = store.messages.length - 1; i >= 0; i--) if (store.messages[i].from === id) return store.messages[i].ts;
  return 0;
}

// The member who has been quiet the longest (not the one picked last time), with a little luck.
function pickSparker(now) {
  const cands = AI_IDS.filter((id) => isActive(id) && !householdFlow.phase(id,now) && !agents[id].busy && !agents[id].wakeAt && !agents[id].imageBusy && now >= agents[id].offlineUntil);
  if (!cands.length) return null;
  const pool = cands.length > 1 ? cands.filter((id) => id !== spark.lastBy) : cands;
  pool.sort((x, y) => lastSaid(x) - lastSaid(y));
  const top = pool.slice(0, 2);
  return agents[top[Math.floor(Math.random() * top.length)]];
}

function maybeSpark(now, sp) {
  if (!sparkOn() || !room.running || room.sleeping || sparkWorldBusy()) return;
  // Activity = anyone (user, members, dev) saying something; system notices don't count.
  const lastReal = [...store.recent(60)].reverse().find((m) => m.from !== 'system');
  const activity = Math.max(lastReal?.ts ?? 0, room.startedAt ?? 0);
  if (activity !== spark.base) {
    // A reserved silence turn can be held by other work. Fresh conversation
    // invalidates that reservation; unread messages get normal reply pacing.
    const reserved = spark.who && agents[spark.who];
    if (reserved && !reserved.busy && reserved.reason === 'spark') {
      reserved.wakeAt = null;
      reserved.reason = null;
      spark.who = null;
    }
    spark.base = activity;
    spark.streak = 0;
    spark.wait = spark.quick ? rand(4, 25) * 1000 : null;
    spark.quick = false;
  }
  if (spark.who) {
    const w = agents[spark.who];
    if (w.busy || w.wakeAt) return; // the pick is still running
    spark.who = null;
  }
  if (AI_IDS.some((id) => agents[id].busy || agents[id].wakeAt || agents[id].imageBusy)) return;
  const after = Array.isArray(cfg.spark.afterSec) ? cfg.spark.afterSec : sp.spark;
  const maxWait = Number.isFinite(cfg.spark.maxWaitSec) && cfg.spark.maxWaitSec > 0 ? cfg.spark.maxWaitSec : sp.sparkMax;
  spark.wait ??= Math.min(rand(...after) * Math.pow(cfg.spark.backoff, spark.streak), maxWait) * 1000;
  if (now < Math.max(spark.base, spark.lastEnd) + spark.wait) return;
  const a = pickSparker(now);
  if (!a) return;
  spark.who = a.id;
  a.wakeAt = now;
  a.reason = 'spark';
  store.log(a.id, `spark: picked after ${Math.round((now - spark.base) / 1000)}s of quiet (streak ${spark.streak})`);
}

// Called when a spark turn ends.
function sparkDone(a, spoke) {
  spark.lastEnd = Date.now();
  spark.lastBy = a.id;
  spark.wait = null;
  spark.streak = spoke ? 0 : spark.streak + 1;
  if (spark.who === a.id) spark.who = null;
}

// Should `id` answer `m` right away? Replies to it and @mentions do. A message from the
// user does too, unless the user is clearly talking to someone else.
function isCalled(m, id) {
  if (m.from === 'system' || m.from === id) return false;
  if (store.getMessage(m.replyTo)?.from === id) return true;
  if (atMentions(m.text, id)) return true;
  if (m.from !== 'user') return false;
  const named = AI_IDS.filter((o) => mentions(m.text, o));
  const repliedTo = store.getMessage(m.replyTo)?.from;
  if (AI_IDS.includes(repliedTo)) return false;
  return !named.length || named.includes(id);
}

// Tell the room once per dev message when the back-and-forth guard kicks in (checked
// against the log, so a server restart does not repeat it).
function noteDevPause(chain) {
  if (!chain) return;
  const lastDev = [...store.recent(80)].reverse().find((m) => m.from === DEV.id);
  if (!lastDev || store.after(lastDev.id).some((m) => m.kind === 'pause')) return;
  post({ from: 'system', kind: 'pause', text: tx().devPause(chain.why) });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- 진심모드: default model for chatter, boost settings when the turn needs it ----

const router = new Router(cfg);
const boostMode = () => room.boostMode || 'auto';
const hasBoost = (id) => boostMode() !== 'off' && !!router.boostOf(id);
const defaultLabel = (id) => cfg.agents[id].model;
const boostLabel = (id) => modelLabel({ ...cfg.agents[id], ...cfg.agents[id].boost });
function selfBoostWait(a) {
  return Math.max(0, cfg.boost.selfCooldownSec * 1000 - (Date.now() - a.lastSelfBoostAt));
}
function startDeep(a, deep) {
  a.deepNow = true;
  if (deep.by === 'self') a.lastSelfBoostAt = Date.now();
  post({ from: 'system', kind: 'deep', by: a.id, text: tx().boostOn(a.id, boostLabel(a.id), deep.reason) });
  store.log(a.id, `route BOOST ${boostLabel(a.id)} by=${deep.by} reason=${deep.reason}`);
  console.log(`[route] ${a.id} ${defaultLabel(a.id)} -> ${boostLabel(a.id)} (${deep.reason})`);
  pushMembers();
}
const turnMeta = (a, deep) => (deep
  ? { model: boostLabel(a.id), deep: true, boostWhy: deep.reason }
  : { model: defaultLabel(a.id) });

// ask() on the boost settings, falling back to the default ones if that call fails.
async function askRouted(a, reason, openFile, deep) {
  if (!deep) return { act: await ask(a, reason, openFile, null), deep: null };
  try {
    return { act: await ask(a, reason, openFile, deep), deep };
  } catch (e) {
    if (shuttingDown) throw e;
    const msg = String(e.message || e);
    store.log(a.id, `route BOOST failed -> default ${defaultLabel(a.id)}: ${msg.slice(0, 200)}`);
    console.log(`[route] ${a.id} boost failed, falling back to ${defaultLabel(a.id)}`);
    a.deepNow = false;
    pushMembers();
    if (room.running) post({ from: 'system', kind: 'error', by: a.id, text: tx().boostFail(a.id, /timeout/.test(msg)) });
    return { act: await ask(a, reason, openFile, null), deep: null };
  }
}

// Photos the user posted since this member last looked (newest 3), for members that can see.
function unseenUploads(a) {
  return store.after(a.seen)
    .filter((m) => m.attach?.upload && fs.existsSync(store.abs(m.attach.path)))
    .slice(-3);
}

async function ask(a, reason, openFile, deep = null) {
  if (shuttingDown) throw new Error('Service stopping');
  const canSee = adapters.canSee(a.id);
  const ups = canSee && !openFile ? unseenUploads(a) : [];
  const images = openFile?.image ? [openFile.image] : ups.map((m) => store.abs(m.attach.path));
  const attached = new Set(ups.map((m) => m.id));
  const homePhotoHint = world.home && cfg.imageGen && avail.gpt
    ? pick({ ko: koPrompts, en: enPrompts, ja: jaPrompts }).photocardBrief : '';
  const sharedHomeHint = world.home ? pick({ ko: koPrompts, en: enPrompts, ja: jaPrompts }).sharedHomeBrief : '';
  const brief = [buildBrief(a.id, cfg, { deep, mode: boostMode(), devOnline: devBridge.online, canSee, homePhotos: !!homePhotoHint }), sharedHomeHint, homePhotoHint,
    living && world.home?.id === 'mulgyeol-maru' ? LIVING_BRIEF : ''].filter(Boolean).join('\n\n');
  const max = adapters.maxPromptChars(a.id) - brief.length - 200;
  const deepWait = !deep && hasBoost(a.id) && boostMode() === 'auto' ? selfBoostWait(a) : 0;
  // Offering a whim consumes its persisted gate once, even if we trim/rebuild history.
  const whim = constructionAllowed(cfg) ? plans.whimCue?.(a.id, reason, store.messages) : null;
  const planSummary = constructionAllowed(cfg) ? plans.summary() : '';
  const topic = topics.context(room);
  const lastPhotoAt = lastHomePhotoAt(store.messages);
  const photoBusy = !!(photocardQueue?.active || photocardQueue?.pending.length || AI_IDS.some(id => agents[id].imageBusy));
  const photoAvailable = !!(world.home && cfg.imageGen && avail.gpt && !photoBusy
    && (photocardQueue ? photocardQueue.available() : !lastPhotoAt || Date.now() - lastPhotoAt >= HOME_PHOTO_GAP_MS));
  const photoMoment = world.home?.id === 'mulgyeol-maru' ? photoMoments.hint({
    home: world.home, avatars: world.avatarView(), world, actor: a.id, messages: store.messages,
    lastPhotoAt, available: photoAvailable && !busyHousehold(living, a.id), nameOf: name,
    hostPending: store.after(a.seen).some(m => m.from === 'user'), continuation: !!openFile,
    blocked: id => ['sleep', 'rest'].includes(householdFlow.phase(id)) || busyHousehold(living,id),
    onOffer: offer => store.log(a.id, 'photo moment offered ' + JSON.stringify(offer)),
  }) : '';
  const rhythm = world.home?.id === 'mulgyeol-maru' && !photoMoment ? roomRhythm.hint(world, a.id, {
    messages: store.recent(400), living: living?.view(), photoBusy,
    hostPending: store.after(a.seen).some(m => m.from === 'user'), continuation: !!openFile,
  }) : '';
  const cozy = world.home?.id === 'mulgyeol-maru' && !rhythm && !photoMoment ? cozyChatHints.hint(world, a.id,
    { living: living?.view(), nameOf: name, photoAvailable: false, allowSeatOffer: !householdFlow.phase(a.id) && roomRhythm.allowSeatOffer(a.id) }) : '';
  const freeTime = world.home?.id === 'mulgyeol-maru' ? householdFlow.context(a.id,name) : '';
  const leisureOffer = world.home?.id === 'mulgyeol-maru' && !openFile && !photoMoment && !busyHousehold(living,a.id) ? householdFlow.offer(a.id,{
    hostPending: store.after(a.seen).some(m=>m.from==='user'),
  }) : '';
  const photoFeedback = a.photoRequestFeedback;
  const photoStatus = photoBusy ? '생활 사진 한 장을 만드는 중. 같은 장면을 추가 신청하지 말고 대화를 이어간다.'
    : lastPhotoAt && Date.now() - lastPhotoAt < HOME_PHOTO_GAP_MS ? '최근 생활 사진을 이미 남겼다. 지금은 추가 촬영보다 이야기를 이어간다.' : '';
  let hist = cfg.historyForPrompt;
  let turn;
  const memoryState = {};
  for (;;) {
    turn = buildTurn(a.id, { store, cfg: { ...cfg, historyForPrompt: hist }, agent: a, reason, openFile, deepWait, canSee, attached, memoryState, world: world.summary(a.id, name), plans: planSummary, whim, topic,
      living: living && world.home?.id === 'mulgyeol-maru' ? living.summary(name) : '',
      cozy: [photoMoment, rhythm, cozy, freeTime, leisureOffer, photoStatus, photoFeedback].filter(Boolean).join('\n') });
    if (turn.length <= max || hist <= 8) break;
    hist -= 8;
  }
  a.calls++;
  room.calls++;
  const now = Date.now();
  a.callTimes = a.callTimes.filter((t) => now - t < 3600000);
  a.callTimes.push(now);
  pushRoom();
  pushUsageSoon();
  const res = await adapters.chat(a.id, brief, turn, { boost: !!deep, images });
  a.lastMs = res.ms;
    store.log(a.id, `turn reason=${reason} model=${deep ? `${boostLabel(a.id)} BOOST` : defaultLabel(a.id)}${images.length ? ` images=${images.length}` : ''} ms=${res.ms} ok=${res.ok} promptChars=${brief.length + turn.length}\n${res.text.slice(0, 4000)}${res.detail ? `\nDETAIL ${res.detail}` : ''}`);
  if (!res.ok) throw new Error(res.detail || 'empty reply');
  const act = availableWorldAction(parseAction(res.text), cfg);
  // A compact memory view cannot safely authorize replacing unseen note lines.
  // Additions and every other action remain available; full-context turns can replace.
  if (act && memoryState.omitted && Object.hasOwn(act, 'note_replace')) {
    delete act.note_replace;
    store.log(a.id, 'note replacement skipped: partial memory view; saved notes preserved');
  }
  if (act && photoFeedback && a.photoRequestFeedback === photoFeedback) a.photoRequestFeedback = null;
  if (!act) store.log(a.id, 'could not parse a JSON action');
  return act;
}

async function runTurn(a) {
  const reason = a.reason;
  a.busy = true;
  a.turnReason = reason;
  a.wakeAt = null;
  a.reason = null;
  a.readBatch = null;
  setStatus(a, 'reading');
  const snapshot = store.lastId;
  let spoke = false;
  // Routing is decided fresh every turn (see lib/router.mjs); no boost unless something asks for it.
  let deep = hasBoost(a.id) ? router.decide(a.id, store, a.seen, boostMode()) : null;
  try {
    if (deep) startDeep(a, deep);
    let r = await askRouted(a, reason, null, deep);
    let act = r.act;
    deep = r.deep;
    const selfAsk = act?.boost ?? act?.deep;
    if (!deep && selfAsk && !Object.hasOwn(act, 'plan_request') && hasBoost(a.id) && boostMode() === 'auto' && room.running && !shuttingDown) {
      if (selfBoostWait(a) > 0) {
        store.log(a.id, 'boost requested while cooling down; answering as usual');
      } else {
        deep = { by: 'self', reason: tx().selfBoost(String(selfAsk).replace(/\s+/g, ' ').slice(0, 100)) };
        // Let the default model's one-line lead-in ("잠깐, 제대로 답할게") through first.
        const lead = Array.isArray(act.messages) ? act.messages.filter(Boolean).slice(0, 1) : [];
        if (lead.length) spoke = await perform(a, { action: 'say', messages: lead, reply_to: act.reply_to }, snapshot, 'urgent', turnMeta(a, null));
        startDeep(a, deep);
        r = await askRouted(a, reason, null, deep);
        act = r.act;
        deep = r.deep;
      }
    }
    // world_shot: photograph the 3D world, post it, and show it to the member (like "open").
    if (act?.world_shot && !act.living && !Object.hasOwn(act, 'leisure') && !PLAN_ACTIONS.some((key) => Object.hasOwn(act, key)) && room.running && !shuttingDown) {
      const shot = await takeWorldShot(a.id, act.world_shot);
      if (shot) {
        r = await askRouted(a, 'open', adapters.canSee(a.id) ? { rel: shot, image: store.abs(shot) } : { rel: shot, text: tx().shotBlind }, deep);
        act = r.act || act;
        deep = r.deep;
      }
      if (act) delete act.world_shot;
    }
    // world_look: hand over a text map of the building world and ask again (like "open").
    if (act?.world_look && !act.living && !Object.hasOwn(act, 'leisure') && !PLAN_ACTIONS.some((key) => Object.hasOwn(act, key)) && room.running && !shuttingDown) {
      r = await askRouted(a, 'open', { rel: tx().worldMap, text: world.look(act.world_look) }, deep);
      act = r.act || act;
      deep = r.deep;
      if (act) delete act.world_look;
    }
    if (act?.open && !act.living && !Object.hasOwn(act, 'leisure') && !PLAN_ACTIONS.some((key) => Object.hasOwn(act, key)) && room.running && !shuttingDown) {
      try {
        const f = store.readFile(act.open);
        let opened;
        if (!f.image) {
          const limit = a.id === 'gemini' ? 12000 : 40000;
          opened = { rel: f.rel, text: f.text.length > limit ? f.text.slice(0, limit) + tx().cut(f.text.length - limit) : f.text };
        } else if (adapters.canSee(a.id)) {
          opened = { rel: f.rel, image: store.abs(f.rel) };
        } else {
          // No eyes: hand over what the room knows about the picture instead.
          const src = store.getMessageByAttachment(f.rel)?.attach;
          const t = tx();
          const about = src?.desc ? t.autoDesc(src.desc) : src?.prompt ? t.artistPrompt(src.prompt) : t.noDesc;
          opened = { rel: f.rel, text: t.blindImage(about) };
        }
        r = await askRouted(a, 'open', opened, deep);
        act = r.act || act;
        deep = r.deep;
      } catch (e) {
        store.log(a.id, `open failed: ${e.message}`);
      }
    }
    // A boosted answer took a while; don't throw it away as stale.
    if (act && room.running && !shuttingDown) spoke = (await perform(a, act, snapshot, deep ? 'urgent' : reason, turnMeta(a, deep))) || spoke;
    a.fails = 0;
    a.lastError = '';
  } catch (e) {
    a.fails++;
    a.lastError = String(e.message || e).slice(0, 300);
    store.log(a.id, `ERROR ${a.lastError}`);
    // back off: 20s, 40s, 80s … up to 5 min
    a.offlineUntil = Date.now() + Math.min(20000 * 2 ** (a.fails - 1), 300000);
  }
  if (reason === 'idle' && !spoke) a.idleStreak++;
  if (reason === 'spark') sparkDone(a, spoke);
  else if (spark.who === a.id) spark.who = null; // the pick got pulled into a normal turn
  a.seen = Math.max(a.seen, snapshot);
  a.lastEnd = Date.now();
  a.idleAt = null;
  a.busy = false;
  a.deepNow = false;
  a.turnReason = null;
  a.status = 'idle';
  saveSoon();
  pushMembers();
}

function typingDelay(text) {
  const sp = SPEEDS[room.speed] || SPEEDS.normal;
  return Math.min(700 + text.length * 40, 4000) * sp.typing;
}

const PLAN_ACTIONS = ['plan_request', 'build_plan', 'plan_cancel', 'plan_pause'];

let planQueueBusy = false, planQueueRetryAt = 0;
async function processPlanQueue() {
  if (!constructionAllowed(cfg)) return null;
  if (shuttingDown || !room.running || room.sleeping || planQueueBusy || Date.now() < planQueueRetryAt) return null;
  planQueueBusy = true;
  let owner;
  try {
    const result = await plans.processNext({
      isRunning: () => !shuttingDown && room.running && !room.sleeping,
      onCall: ({ by }) => {
        owner = by;
        // All queued designs use the separate Astra account, regardless of owner.
        const now = Date.now();
        room.calls++;
        agents.gpt.callTimes = agents.gpt.callTimes.filter((t) => now - t < 3600000);
        agents.gpt.callTimes.push(now);
        store.saveState();
        pushRoom();
        pushUsageSoon();
      },
    });
    if (!result) return null;
    broadcast('plans', plans.view());
    post({ from: 'system', kind: 'world', by: result.plan.owner, text: planNotice(result.plan) });
    return result;
  } catch (e) {
    // A damaged ledger/IO error must not become an error bubble every tick.
    planQueueRetryAt = Date.now() + 30000;
    store.log(e.by || owner || 'system', `queued plan failed: ${String(e.message || e).slice(0, 300)}`);
    worldActionError(e.by || owner || 'system', 'plan_request', e);
    return null;
  } finally { planQueueBusy = false; }
}

let continuationBusy = false, continuationRetryAt = 0;
async function continuePlan(now = Date.now()) {
  if (!constructionAllowed(cfg)) return;
  if (shuttingDown || !room.running || room.sleeping || continuationBusy || now < continuationRetryAt) return;
  let job;
  continuationBusy = true;
  try {
    job = plans.nextContinuation();
    if (!job || now < job.nextDueAt) return;
    const ok = await performWorldAction(agents[job.by], { build_plan: { id: job.id, stage: 'next' } }, { scheduled: true });
    if (!ok) {
      // Do not hammer a damaged site or disk. Leave the journal intact for a
      // deliberate recovery; no automatic model request or redesign follows.
      plans.pause(job.id, job.by, { reason: '예약 시공에 실패해 이어 짓기를 멈췄어. 최근 오류를 확인한 뒤 예약자나 설계자가 continue:true로 재개해.' });
      continuationRetryAt = now + 30000;
    }
  } catch (e) {
    continuationRetryAt = now + 30000;
    store.log(job?.by ?? 'system', `plan continuation paused: ${String(e.message || e).slice(0, 300)}`);
    worldActionError(job?.by ?? 'system', 'build_plan', e, true);
  } finally { continuationBusy = false; }
}

// Character-facing notices contain only public progress, never adapter errors/settings.
function planNotice(plan, stageName = '', outcome = {}) {
  const title = String(plan.title || '').replace(/[\r\n]+/g, ' ').slice(0, 100);
  if (plan.status === 'queued') return pick({
    ko: `📐 ${plan.ref} ${title} · 설계 요청 접수${plan.queuePosition ? ` · 대기 ${plan.queuePosition}번` : ''}.`,
    en: `📐 ${plan.ref} ${title} · Design request saved${plan.queuePosition ? ` · queue #${plan.queuePosition}` : ''}. It will start in turn; no need to request again.`,
    ja: `📐 ${plan.ref} ${title} · 設計依頼を受付${plan.queuePosition ? ` · ${plan.queuePosition}番待ち` : ''}。順番に設計するので再依頼は不要だよ。`,
  });
  let status = pick({
    ko: { draft: '설계 준비 완료 · 아직 짓지 않았어', building: '짓는 중', complete: '건축 완료', cancelled: '설계 취소', failed: '설계 실패', blocked: '부지 확인이 필요해' },
    en: { draft: 'Design ready · not built yet', building: 'Building', complete: 'Built', cancelled: 'Cancelled', failed: 'Design failed', blocked: 'Site needs checking' },
    ja: { draft: '設計準備完了 · まだ建てていないよ', building: '建築中', complete: '建築完了', cancelled: '取消済み', failed: '設計失敗', blocked: '敷地の確認が必要だよ' },
  })[plan.status] || '';
  if (plan.status === 'draft' && (plan.preparing || !plan.stages.length)) {
    status = pick({ ko: '설계 중', en: 'Design in progress', ja: '設計中' });
  }
  const completed = plan.completedStages;
  if (outcome.duplicate) return pick({
    ko: `${plan.ref} ${title}: 이미 완료한 단계야. 새 블록 0칸. ${plan.nextStage ? `다음은 ${plan.nextStage}단계, ${plan.stageWaitSec}초 뒤 stage:"next"를 선택해.` : '모든 단계가 끝났어.'}`,
    en: `${plan.ref} ${title}: already done; 0 new cells. ${plan.nextStage ? `Next phase ${plan.nextStage}; use stage:"next" after ${plan.stageWaitSec}s.` : 'All phases are finished.'}`,
    ja: `${plan.ref} ${title}: 完了済み。新しいブロックは0マス。${plan.nextStage ? `次は第${plan.nextStage}段階。${plan.stageWaitSec}秒後にstage:"next"を選んで。` : '全段階が終了済み。'}`,
  });
  const progress = plan.stages.length ? pick({
    ko: ` · ${completed}/${plan.stages.length}단계`,
    en: ` · stages ${completed}/${plan.stages.length}`,
    ja: ` · ${completed}/${plan.stages.length}段階`,
  }) : '';
  const stageLabel = stageName && outcome.phaseCompleted !== false ? pick({
    ko: ['기초·바닥', '벽·창문·출입구', '지붕', '현관·장식'],
    en: ['Foundation and floor', 'Walls and entrance', 'Roof', 'Front step and details'],
    ja: ['基礎・床', '壁・窓・出入口', '屋根', '玄関・装飾'],
  })[completed - 1] || '' : '';
  const job = plan.continuation;
  const schedule = job ? pick({
    ko: job.paused ? ' · 이어 짓기 일시정지' : ` · 이어 짓기 ${job.waitSec}초 후 (방 정지·수면 중 보류)`,
    en: job.paused ? ' · continuation paused' : ` · continuing in ${job.waitSec}s (held while stopped/asleep)`,
    ja: job.paused ? ' · 続きは一時停止中' : ` · ${job.waitSec}秒後に続行（停止・睡眠中は保留）`,
  }) : '';
  const recovery = outcome.recovered && !outcome.advanced ? pick({ ko: ' · 저장된 시공 기록 복구, 새 블록 0칸', en: ' · recovered saved progress, 0 new cells', ja: ' · 保存済みの進捗を復旧、新規0マス' }) : '';
  return `📐 ${title} · ${status}${progress}${stageLabel ? ` · ${stageLabel}` : ''}${plan.stageOffset ? ` · ${plan.builtCells}/${plan.count}` : ''}${schedule}${recovery}`;
}

function worldActionError(id, kind, error, continuation = false) {
  const text = pick({
    ko: {
      mixed: '한 행동에는 설계 요청·단계 건축·설계 취소 중 하나만 넣고, build/block_define과 섞지 마. 이번 월드 작업은 실행하지 않았어.',
      raw: '작은 장식·수리는 한 번에 24칸까지, 진행 중인 설계 부지 밖에서 해. 새 건물은 plan_request로 설계부터 부탁해. 이번 월드 작업은 실행하지 않았어.',
      plan_request: '설계 요청을 완료하지 못했어. 설계 목록과 부지·요청 내용을 확인해 줘.',
      build_plan: '단계를 진행하지 못했어. 설계 목록의 다음 단계·대기 시간·부지 상태를 확인해 줘.',
      build_plan_saved: '블록은 보존됐지만 진행 기록 확인이 필요해.',
      plan_cancel: '설계를 취소하지 못했어. 설계 번호와 요청한 사람을 확인해 줘.',
      plan_pause: '이어 짓기를 일시정지하지 못했어.',
    },
    en: {
      mixed: 'Choose just one plan action; do not combine it with build/block_define. No world work from this action was applied.',
      raw: 'Keep small repairs/decor to 24 cells outside reserved plans. Request new buildings with plan_request. No world work from this action was applied.',
      plan_request: 'The plan request could not be completed. Check the plan list, site and request.',
      build_plan: 'The stage could not proceed. Check the next stage, waiting time and site in the plan list.',
      build_plan_saved: 'The placed blocks are preserved, but the stage record needs checking.',
      plan_cancel: 'The plan could not be cancelled. Check its ID and who requested it.',
      plan_pause: 'The continuation could not be paused.',
    },
    ja: {
      mixed: '設計の依頼・段階の建築・取消は一度に一つだけ。build/block_defineと混ぜないで。今回のワールド作業は実行していないよ。',
      raw: '小さな装飾・修理は一度に24マスまで、予約された設計の敷地の外で。新しい建物はplan_requestで設計を頼んでね。今回のワールド作業は実行していないよ。',
      plan_request: '設計の依頼を完了できなかったよ。設計一覧、敷地と依頼内容を確認してね。',
      build_plan: 'この段階を進められなかったよ。設計一覧の次の段階、待ち時間、敷地の状態を確認してね。',
      build_plan_saved: '置いたブロックは保存されているけれど、進行記録の確認が必要だよ。',
      plan_cancel: '設計を取り消せなかったよ。設計番号と依頼した人を確認してね。',
      plan_pause: '続きの建築を一時停止できなかったよ。',
    },
  })[kind];
  // Only our validated domain errors are public. Provider/disk exceptions stay
  // in the private log; structured reasons survive in messages for next turns.
  const translated = error instanceof PlanError ? pick({
    ko: {},
    en: {
      planner_busy: 'Another design is in progress. This request was not queued. Wait for its result and the request cooldown, then retry.',
      request_quota: 'The rolling 24-hour design limit is used up. Retry after the countdown.',
      request_cooldown: 'The room design-request cooldown is active. Retry after the countdown.',
      member_cooldown: 'Your design-request cooldown is active. Retry after the countdown.',
      stage_cooldown: 'This plan is cooling down. Use stage:"next" after the countdown.',
      stage_order: 'That phase cannot run now. Use stage:"next" from the current shared plan list.',
      plan_paused: 'Continuation is paused. Its starter or the owner can resume with continue:true.',
      continuation_owner: 'Only the continuation starter or plan owner may change the reservation.',
      site_changed: 'The reserved site changed externally. Construction stopped and existing blocks were preserved. The owner can cancel and request a clear site.',
      plan_preparing: 'The design is still in progress. Choose build_plan after it is ready.',
      planner_failed: 'The design call failed. There is no automatic retry; retry after the request countdown.',
      planner_timeout: 'The design call timed out. Wait for the pending call to end and the request countdown before retrying.',
      invalid_recipe: 'The returned design did not satisfy the recipe/building rules. Revise the request before retrying.',
    },
    ja: {
      planner_busy: '別の設計を処理中。この依頼は未受付だよ。結果と待ち時間を確認してから再依頼してね。',
      request_quota: '直近24時間の設計上限に達したよ。残り時間後に再依頼してね。',
      request_cooldown: '部屋の設計依頼は待機中。残り時間後に再依頼してね。',
      member_cooldown: 'あなたの設計依頼は待機中。残り時間後に再依頼してね。',
      stage_cooldown: 'この設計の施工は待機中。残り時間後にstage:"next"を選んでね。',
      stage_order: 'その段階は今は進められない。最新の共有一覧からstage:"next"を使ってね。',
      plan_paused: '続行は一時停止中。予約した人か設計者がcontinue:trueで再開できるよ。',
      continuation_owner: '予約した人か設計者だけが続行の予約を変更できるよ。',
      site_changed: '敷地が外部から変わったため施工を停止したよ。既存のブロックは保存済み。設計者が取消して空き地で再依頼してね。',
      plan_preparing: 'まだ設計中。準備完了後にbuild_planを選んでね。',
      planner_failed: '設計の呼び出しが失敗したよ。自動再試行はしないので残り時間後に再依頼してね。',
      planner_timeout: '設計が時間切れになったよ。処理の終了と待ち時間を確認してから再依頼してね。',
      invalid_recipe: '設計の応答が建築ルールに合わなかったよ。依頼内容を修正して再依頼してね。',
    },
  })[error.code] || error.message : null;
  const genericReason = pick({
    ko: '월드 작업 또는 진행 기록 저장에 실패했어. 저장 상태와 최근 오류 기록을 확인한 뒤 stage:"next"로 재시도해.',
    en: 'World work or progress persistence failed. Check the saved state and error log before retrying stage:"next".',
    ja: 'ワールド作業か進捗の保存に失敗したよ。保存状態とエラー記録を確認してからstage:"next"で再試行してね。',
  });
  const detail = error instanceof PlanError ? {
    code: error.code, reason: translated, retryAfterSec: error.retryAfterSec ?? null,
    nextStage: error.nextStage ?? null, queued: error.queued ?? false,
  } : error ? { code: 'plan_io_error', reason: genericReason } : null;
  const wait = detail?.retryAfterSec !== null && detail?.retryAfterSec !== undefined ? pick({
    ko: ` 재시도까지 ${detail.retryAfterSec}초.`, en: ` Retry in ${detail.retryAfterSec}s.`, ja: ` ${detail.retryAfterSec}秒後に再確認。`,
  }) : '';
  const reason = detail?.reason || text;
  const paused = continuation ? pick({ ko: ' 이어 짓기는 일시정지해.', en: ' Continuation is paused.', ja: ' 続行は一時停止するよ。' }) : '';
  post({ from: 'system', kind: 'error', by: id, text: reason + wait + paused, ...(detail ? { planError: detail } : {}), ...(continuation ? { continuation: true } : {}) });
}

// Dry-run legacy operations on detached state. Never mutate then roll back the live world.
function preflightRawWorld(act) {
  if (!act.build) return;
  const preview = Object.assign(Object.create(World.prototype), world, {
    blocks: new Map(world.blocks), signs: structuredClone(world.signs),
    custom: structuredClone(world.custom), log: structuredClone(world.log),
    avatars: structuredClone(world.avatars), save() {},
  });
  for (const def of (Array.isArray(act.block_define) ? act.block_define : act.block_define ? [act.block_define] : []).slice(0, 4)) {
    try { preview.define(def, 'preview'); } catch { /* live path reports individual definition errors */ }
  }
  if (act.build) {
    const result = preview.apply(act.build, 'preview');
    if (result.changes.length + result.signs > 24) throw new Error('raw build exceeds 24 cells');
    const signKeys = new Set([...Object.keys(world.signs), ...Object.keys(preview.signs)]);
    const changedSigns = [...signKeys]
      .filter((key) => JSON.stringify(world.signs[key]) !== JSON.stringify(preview.signs[key]))
      .map((key) => key.split(',').map(Number));
    plans.assertRawChanges([...result.changes, ...changedSigns]);
  }
}

async function performWorldAction(a, act, { scheduled = false } = {}) {
  if (Object.hasOwn(act,'leisure')) {
    if (shuttingDown || !room.running || room.sleeping || world.home?.id !== 'mulgyeol-maru') return false;
    const mixed = [...PLAN_ACTIONS,'build','block_define','move','useFurniture','living','open','world_look','world_shot','image'].some(key=>Object.hasOwn(act,key));
    const request = leisureRequest(act.leisure);
    if (mixed || !request) {
      post({from:'system',kind:'info',by:a.id,text:'자유시간 요청의 종류와 시간을 확인해 주세요. 이동·생활 도구·촬영과는 따로 선택할 수 있습니다.'});
      return false;
    }
    if (photocardQueue?.active || photocardQueue?.pending.length || AI_IDS.some(id=>agents[id].imageBusy)) return false;
    if (!householdFlow.canStart(a.id,request)) {
      store.log(a.id,'leisure deferred: awake interval');
      return false;
    }
    const result = enterLeisure(world,a.id,request.kind,{living,sequence:store.lastId});
    if (!result.ok) {
      store.log(a.id,`leisure unavailable: ${result.error}`);
      return false;
    }
    householdFlow.start(a.id,request); saveSoon();
    broadcast('avatars',world.avatarView()); pushMembers();
    return true;
  }
  if (Object.hasOwn(act, 'living')) {
    if (shuttingDown || !room.running || room.sleeping) return false;
    let result;
    try {
      result = LIVING_CONFLICTS.some(key => Object.hasOwn(act, key))
        ? { ok: false, text: '생활 행동은 이동·가구·파일 열기·촬영·건축 행동과 나누어 요청해 주세요.' }
        : applyLivingAction(living, world, a.id, act.living);
    } catch { result = { ok: false, text: '생활 상태를 저장하지 못했습니다. 완료되지 않았습니다.' }; }
    if (result.ok && result.changed) {
      broadcast('living', publicLiving(living.view(), publicIdentity));
      broadcast('avatars', world.avatarView());
    }
    const superseded = result.error === 'stale_revision';
    if (result.text || !result.ok) post({ from: 'system', kind: result.ok ? 'world' : superseded ? 'info' : 'error', by: a.id,
      text: superseded ? pick({ ko: '생활 상태가 먼저 변경되어 이전 상태를 기준으로 한 행동은 실행하지 않았습니다. 다음 대화에서 현재 상태를 확인할 수 있습니다.',
        en: 'The household state changed first, so the outdated action was not performed. The current state will be available next turn.',
        ja: '生活の状態が先に変わったため、以前の状態に基づく行動は実行されませんでした。次の会話で現在の状態を確認できます。' })
        : livingText(result.text || '생활 요청을 처리하지 못했습니다. 다음 대화에서 현재 상태를 확인해 주세요.') });
    return result.ok && result.changed;
  }
  act = availableWorldAction(act, cfg);
  const id = a.id;
  if (shuttingDown || !room.running || room.sleeping) return false;
  const selected = PLAN_ACTIONS.filter((key) => Object.hasOwn(act, key));
  if (selected.length > 1 || (selected.length && ['build', 'block_define', 'useFurniture'].some((key) => Object.hasOwn(act, key)))) {
    worldActionError(id, 'mixed');
    return false;
  }
  if (selected.length) {
    const action = selected[0];
    let beforeStage = null;
    try {
      if (shuttingDown || !room.running) return false;
      let plan, stageName, outcome = {};
      if (action === 'plan_request') {
        ({ plan } = plans.enqueue(act.plan_request, id, { isRunning: () => !shuttingDown && room.running && !room.sleeping }));
        setStatus(a, 'reading');
        broadcast('plans', plans.view());
        post({ from: 'system', kind: 'world', by: id, text: planNotice(plan) });
        await processPlanQueue();
        return true;
      } else if (action === 'build_plan') {
        beforeStage = new Map(world.blocks);
        const result = plans.execute(act.build_plan, id, { isRunning: () => !shuttingDown && room.running && !room.sleeping, scheduled });
        beforeStage = null;
        if (!result) return true; // a concurrent pause/cancel invalidated the wake hint
        outcome = result;
        ({ plan, stageName } = result);
        if (result.changes.length) broadcast('world', { by: id, changes: result.changes });
        if (result.signs) broadcast('signs', world.signs);
        if (room.running && result.advanced && !scheduled && !act.move) {
          const last = result.changes[result.changes.length - 1];
          world.move(id, { x: last[0], z: last[2] + 1 });
        }
        // A stage may also change standing heights; always refresh avatars before progress.
        if (result.changes.length) broadcast('avatars', world.avatarView());
      } else if (action === 'plan_pause') {
        plan = plans.pause(act.plan_pause?.id, id);
      } else {
        plan = plans.cancel(act.plan_cancel?.id, id);
      }
      if (room.running && act.move) {
        world.move(id, act.move);
        broadcast('avatars', world.avatarView());
      }
      // A room-off request may finish as a stored draft/cancellation; never build or move.
      if (!scheduled || outcome.phaseCompleted) post({ from: 'system', kind: outcome.duplicate ? 'info' : 'world', by: id,
        text: planNotice(plan, stageName, outcome), ...(scheduled ? { continuation: true } : {}),
        ...(action === 'build_plan' ? { planProgress: { ref: plan.ref, advanced: outcome.advanced, recovered: outcome.recovered,
          duplicate: outcome.duplicate, completedStages: plan.completedStages, builtCells: plan.builtCells, nextStage: plan.nextStage } } : {}) });
      return !outcome.duplicate;
    } catch (e) {
      let savedChanges = false;
      if (beforeStage) {
        // World persistence can succeed before the plan journal commit fails.
        // Publish what is already there, without reapplying or moving anyone.
        const keys = new Set([...beforeStage.keys(), ...world.blocks.keys()]);
        const changes = [...keys].filter((key) => beforeStage.get(key) !== world.blocks.get(key))
          .map((key) => [...key.split(',').map(Number), world.blocks.get(key) ?? null]);
        if (changes.length) {
          broadcast('world', { by: id, changes });
          broadcast('avatars', world.avatarView());
          savedChanges = true;
        }
      }
      store.log(id, `world plan action ${action} failed: ${String(e.message || e).slice(0, 300)}`);
      worldActionError(id, savedChanges ? 'build_plan_saved' : action, savedChanges ? undefined : e, scheduled);
      return false;
    }
  }

  if (shuttingDown || !room.running) return false;
  try { preflightRawWorld(act); } catch {
    worldActionError(id, 'raw');
    return false;
  }
  let visible = false;
  let moved = false;
  for (const def of (Array.isArray(act.block_define) ? act.block_define : act.block_define ? [act.block_define] : []).slice(0, 4)) {
    if (shuttingDown || !room.running) return visible;
    try {
      const n = world.define(def, id);
      broadcast('worldblocks', world.custom);
      post({ from: 'system', kind: 'world', by: id, text: tx().newBlock(id, n) });
      visible = true;
    } catch (e) {
      post({ from: 'system', kind: 'error', by: id, text: tx().blockFail(id, e.message) });
    }
  }
  if (act.build && room.running && !shuttingDown) {
    const r = world.apply(act.build, id);
    if (r.changes.length) {
      broadcast('world', { by: id, changes: r.changes });
      const last = r.changes[r.changes.length - 1];
      if (room.running && !act.move) moved = world.move(id, { x: last[0], z: last[2] + 1 });
    }
    if (r.signs) broadcast('signs', world.signs);
    if (r.changes.length || r.signs) {
      post({ from: 'system', kind: 'world', by: id, text: `🧱 ${name(id)} ${world.log[world.log.length - 1].text}` });
      visible = true;
    }
    if (r.notes.length) post({ from: 'system', kind: 'error', by: id, text: tx().buildNotes(id, r.notes.slice(0, 3).join(' / ')) });
  }
  if (act.move && room.running && !shuttingDown) moved = world.move(id, act.move) || moved;
  if (moved) broadcast('avatars', world.avatarView());
  if (Object.hasOwn(act, 'useFurniture') && room.running && !room.sleeping) {
    try {
      const at = act.useFurniture;
      if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isSafeInteger)) throw new Error(pick({
        ko: 'useFurniture는 가구의 정수 좌표 [x,y,z]여야 해.', en: 'useFurniture needs the furniture coordinates [x,y,z] as integers.', ja: 'useFurnitureは家具の整数座標[x,y,z]にしてね。',
      }));
      if (typeof world.useFurniture !== 'function') throw new Error(pick({
        ko: '이 월드는 아직 가구 사용을 지원하지 않아.', en: 'This world does not support furniture use yet.', ja: 'このワールドはまだ家具の使用に対応していないよ。',
      }));
      const result = world.useFurniture(id, at);
      if (!result || result.ok === false) {
        const reasons = pick({
          ko: { invalid_target: '월드 안의 가구 좌표 [x,y,z]를 확인해.', not_furniture: '그 좌표에는 가구가 없어. 현재 월드에서 가구 위치를 확인해.', unsupported: '가구 아래에 받침이 없어. 받침을 마련한 뒤 다시 사용해.', blocked: '가구를 쓸 공간이 막혔어. 머리 위나 앞쪽 공간을 확인해.', occupied: '다른 멤버가 사용 중이야. 다른 가구를 고르거나 기다려.', unreachable: '현재 위치에서는 해당 가구에 갈 수 없습니다. 통로를 확인하거나 가까운 가구를 선택해 주세요.', unknown_avatar: '이 멤버의 아바타를 찾을 수 없어.' },
          en: { invalid_target: 'Check the furniture coordinates [x,y,z] inside the world.', not_furniture: 'No furniture there. Check its current location.', unsupported: 'The furniture needs support underneath before use.', blocked: 'The space above or in front of the furniture is blocked.', occupied: 'Someone is using it. Choose another piece or wait.', unreachable: 'That furniture is out of reach from here. Please check the walkway or choose nearby furniture.', unknown_avatar: 'This member has no avatar.' },
          ja: { invalid_target: 'ワールド内の家具座標[x,y,z]を確認して。', not_furniture: 'そこに家具はないよ。現在の位置を確認して。', unsupported: '家具の下に支えが必要だよ。', blocked: '家具の上か前が塞がっているよ。', occupied: '他のメンバーが使用中。別の家具を選ぶか待って。', unreachable: '現在の場所からはその家具に移動できません。通路を確認するか、近くの家具を選んでください。', unknown_avatar: 'このメンバーのアバターが見つからないよ。' },
        });
        const error = new Error(reasons[result?.error] || pick({ ko: '그 가구를 사용할 수 없어.', en: 'That furniture cannot be used.', ja: 'その家具は使えないよ。' }));
        error.furnitureCode = result?.error ?? 'unavailable';
        throw error;
      }
      const avatars = world.avatarView();
      broadcast('avatars', avatars);
      post({ from: 'system', kind: 'world', by: id, furnitureUse: { at, posture: avatars[id]?.posture ?? null }, text: pick({
        ko: `${name(id)}: (${at.join(',')}) 가구 사용.`, en: `${name(id)} used the furniture at (${at.join(',')}).`, ja: `${name(id)}が(${at.join(',')})の家具を使ったよ。`,
      }) });
      visible = true;
    } catch (e) {
      post({ from: 'system', kind: 'error', by: id, furnitureError: e.furnitureCode ?? 'invalid_action', text: pick({
        ko: `가구 사용 실패: ${e.message}`, en: `Furniture use failed: ${e.message}`, ja: `家具を使えなかった: ${e.message}`,
      }) });
    }
  }
  return visible;
}

// Apply one parsed action. Returns true if the AI said something visible.
// meta: {model, deep} stamped on the messages this turn posts.
async function perform(a, act, snapshot, reason, meta = {}) {
  if (shuttingDown) return false;
  const id = a.id;
  let visible = false;
  // Reject incompatible actions before any files, speech or image request runs.
  if (Object.hasOwn(act, 'leisure') && (!leisureRequest(act.leisure)
    || [...PLAN_ACTIONS, 'build', 'block_define', 'move', 'useFurniture', 'living', 'open', 'world_look', 'world_shot', 'image'].some(key => Object.hasOwn(act, key)))) {
    post({ from: 'system', kind: 'info', by: id, text: '자유시간 요청의 종류와 시간을 확인해 주세요. 이동·생활 도구·촬영과는 따로 선택할 수 있습니다.' });
    return false;
  }

  if (act.react && Number(act.react.id) && act.react.emoji) {
    react(Number(act.react.id), id, String(act.react.emoji).slice(0, 8));
    visible = true;
  }

  let notesChanged = false;
  if (typeof act.note_replace === 'string' && act.note_replace.trim()) { store.writeNote(id, act.note_replace); notesChanged = true; }
  if (typeof act.note_add === 'string' && act.note_add.trim()) { store.appendNote(id, act.note_add); notesChanged = true; }
  if (notesChanged) broadcast('notes', { id, text: store.readNote(id) });

  let msgs = Array.isArray(act.messages) ? act.messages : (typeof act.messages === 'string' ? [act.messages] : []);
  msgs = msgs.map((s) => formatMemberSpeech(id, s).trim()).filter(Boolean).slice(0, 4).map((s) => s.slice(0, 2000));
  if (act.action === 'pass' && !act.show) msgs = [];

  // If the room moved on a lot while this AI was thinking, drop the stale chatter.
  const movedOn = store.after(snapshot).filter((m) => m.from !== id && m.from !== 'system').length;
  if (msgs.length && movedOn >= 3 && reason !== 'urgent') {
    store.log(id, `dropped stale messages (${movedOn} new since snapshot)`);
    msgs = [];
  }

  const replyTo = Number(act.reply_to);
  let first = true;
  const spokenTexts = [];
  for (const text of msgs) {
    setStatus(a, 'typing');
    await sleep(typingDelay(text));
    if (shuttingDown || !room.running) break;
    let mayPost;
    a.pacing = true;
    try {
      mayPost = await bubblePacer.wait({ active: () => !shuttingDown && room.running && !room.sleeping,
        gapMs: () => (SPEEDS[room.speed] || SPEEDS.normal).bubbleGap * 1000, sleep });
    } finally { a.pacing = false; }
    if (!mayPost) break;
    post({ from: id, text, replyTo: first && store.getMessage(replyTo) ? replyTo : undefined, ...meta });
    spokenTexts.push(text);
    first = false;
    visible = true;
  }

  // In particular, stopping while the typing delay was pending must stop world writes.
  if (shuttingDown || !room.running) return visible;

  let wsChanged = false;
  const invalidFiles = Object.hasOwn(act, 'files') && !Array.isArray(act.files);
  if (invalidFiles) {
    post({ from: 'system', kind: 'error', by: id, text: tx().fileFail(id, pick({
      ko: 'files는 문자열이 아닌 파일 작업 배열이어야 해. 저장하지 않았어.',
      en: 'files must be an array of file operations, not a string. Nothing was saved.',
      ja: 'filesは文字列ではなくファイル操作の配列にしてね。保存していないよ。',
    })) });
  }
  for (const op of (Array.isArray(act.files) ? act.files : []).slice(0, 6)) {
    if (!op || typeof op !== 'object') continue;
    try {
      const r = store.applyFileOp(op, id);
      wsChanged = true;
      visible = true;
      post({ from: 'system', kind: 'file', by: id, file: r.op === 'delete' ? undefined : r.rel, text: `${name(id)} → ${r.rel} ${tx().verb[r.op] || r.op}` });
    } catch (e) {
      post({ from: 'system', kind: 'error', by: id, text: tx().fileFail(id, e.message) });
    }
  }
  if (wsChanged) broadcast('ws', store.listFiles());

  if (act.show && !invalidFiles && room.running && !shuttingDown) {
    try {
      const rel = store.safeRel(act.show);
      if (fs.existsSync(store.abs(rel))) {
        post({ from: id, text: '', attach: { path: rel }, ...meta });
        visible = true;
      } else {
        post({ from: 'system', kind: 'error', by: id, text: tx().showMissing(id, rel) });
      }
    } catch (e) {
      store.log(id, `show failed: ${e.message}`);
    }
  }

  visible = (await performWorldAction(a, act)) || visible;
  if (shuttingDown || !room.running) return visible;

  if (act.sticker_save && typeof act.sticker_save === 'object') {
    try {
      const r = saveSticker(act.sticker_save.from, act.sticker_save.to, id);
      post({ from: 'system', kind: 'file', by: id, file: r, text: tx().stickerSaved(id, r) });
      broadcast('ws', store.listFiles());
      visible = true;
    } catch (e) {
      post({ from: 'system', kind: 'error', by: id, text: tx().stickerFail(id, e.message) });
    }
  }

  if (act.sticker && room.running && !shuttingDown) {
    const rel = stickerPath(act.sticker);
    if (rel && fs.existsSync(store.abs(rel))) {
      post({ from: id, text: '', attach: { path: rel, sticker: true }, ...meta });
      visible = true;
    } else {
      store.log(id, `sticker not found: ${act.sticker}`);
    }
  }

  if (act.image && cfg.imageGen) {
    const req = imageRequest(act.image, id);
    if (!req) {
      a.photoRequestFeedback = '직전 이미지 요청은 형식이나 대상이 불명확해 접수되지 않았다. 생활 사진은 image.photocard:true와 정확한 공개 이름의 subjects가 필요하다. 완성됐다고 말하거나 같은 요청을 반복하지 않는다.';
    } else if (req.photocard || MEMBERS[id].imageGen) {
      void startImage(a, req).then(result => {
        if (result?.accepted === false) a.photoRequestFeedback = '직전 생활 사진 요청은 접수되지 않았다. 사진이 완성됐다고 말하거나 반복 요청하지 않고 대화를 이어간다.';
        else if (result?.accepted) a.photoRequestFeedback = '생활 사진 요청을 접수했다. 실제 첨부가 올라오면 확인하고, 기다리는 동안 준비·렌즈·포즈 안내를 반복할 필요 없이 하던 수다를 이어가도 된다.';
      }).catch(() => { a.photoRequestFeedback = '직전 이미지 요청을 시작하지 못했다. 완성된 사진으로 말하지 않는다.'; });
      visible = true;
    }
  }
  const rest = !Object.hasOwn(act,'leisure') && !act.image && !act.living && !act.move && !act.useFurniture && restIntent(spokenTexts.join(' '));
  if (rest && !shuttingDown && room.running && !room.sleeping && world.home?.id === 'mulgyeol-maru'
    && !photocardQueue?.active && !photocardQueue?.pending.length && !AI_IDS.some(id=>agents[id].imageBusy)
    && householdFlow.canStart(id,{kind:rest})) {
    const result = enterLeisure(world,id,rest,{living});
    // Resting is still a valid choice when a preferred seat is occupied; no pretend movement.
    if (result.ok || result.error === 'unavailable') {
      householdFlow.start(id,{kind:rest}); saveSoon();
      if (result.ok) broadcast('avatars',world.avatarView());
    }
  }
  return visible;
}

// ---- stickers: images under stickers/ in the workspace, shown small with no bubble ----

// A workspace path under stickers/ with an image extension, or null.
function stickerPath(p) {
  try {
    const rel = store.safeRel(p);
    return rel.startsWith('stickers/') && store.isImage(rel) ? rel : null;
  } catch {
    return null;
  }
}

// Copy a workspace image (e.g. a generated one in images/) into stickers/.
function saveSticker(from, to, by) {
  const src = store.safeRel(from);
  if (!store.isImage(src) || !fs.existsSync(store.abs(src))) throw new Error(tx().noImage(src));
  const dst = stickerPath(to);
  if (!dst) throw new Error(tx().stickerPath);
  if (path.posix.extname(dst).toLowerCase() !== path.posix.extname(src).toLowerCase()) throw new Error(tx().stickerExt);
  const existed = fs.existsSync(store.abs(dst));
  if (!existed && store.listFiles().length >= 300) throw new Error(tx().fileLimit);
  fs.mkdirSync(path.dirname(store.abs(dst)), { recursive: true });
  fs.copyFileSync(store.abs(src), store.abs(dst));
  store.touchMeta(dst, by, !existed);
  return dst;
}

// Screenshot of the 3D world for a member (lib/worldshot.mjs). Returns the workspace path
// of the PNG, or null (the failure is posted to the room).
async function takeWorldShot(id, req) {
  const v = req && typeof req === 'object' ? req : {};
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : undefined);
  const at = Array.isArray(v.at) ? v.at : [v.x, v.z];
  const vec = (a, n) => (Array.isArray(a) && a.length === n && a.every((x) => num(x) !== undefined) ? a.map(Number) : null);
  const from = vec(v.from, 3), lookAt = vec(v.look_at, 3), quat = vec(v.quat, 4);
  // A camera placed inside a block only sees that block's inside: lift it to the first
  // free cell above and say so.
  if (from) {
    const [fx, fy0, fz] = from.map(Math.round);
    let fy = Math.max(1, fy0);
    const solid = (y) => { const b = world.blocks.get(`${fx},${y},${fz}`); return b && !String(b).startsWith('door'); };
    while (fy < 40 && solid(fy)) fy++;
    if (fy !== from[1]) {
      post({ from: 'system', kind: 'world', by: id, text: tx().cameraLift(id, fx, from[1], fz, fy) });
      from[1] = fy;
    }
  }
  const opts = {
    night: v.night === true || v.night === 'true' || v.night === 1,
    view: v.view === 'top' ? 'top' : 'iso',
    // orbit camera: look at (at) from dist away, angle around it, pitch above the horizon
    tx: num(at[0]) !== undefined ? num(at[0]) + 0.5 : undefined,
    tz: num(at[1]) !== undefined ? num(at[1]) + 0.5 : undefined,
    dist: num(v.dist),
    angle: num(v.angle),
    elev: from ? undefined : num(v.pitch),
    // free camera: stand in a cell and look somewhere
    cx: from?.[0], cy: from?.[1], cz: from?.[2],
    lx: lookAt?.[0], ly: lookAt?.[1], lz: lookAt?.[2],
    yaw: from ? num(v.yaw) : undefined,
    pitch: from ? num(v.pitch) : undefined,
    qx: quat?.[0], qy: quat?.[1], qz: quat?.[2], qw: quat?.[3],
    fov: num(v.fov),
    cut: num(v.cut_y),
  };
  setStatus(agents[id], 'reading');
  try {
    const png = await shootWorld(HOME_DIR, cfg.port, opts);
    if (shuttingDown || !room.running) return null;
    const rel = `images/${saveImageFile(store.abs('images'), { data: png, extension: '.png' })}`;
    store.touchMeta(rel, id, true);
    post({ from: id, text: '', attach: { path: rel, shot: true } });
    broadcast('ws', store.listFiles());
    return rel;
  } catch (e) {
    if (shuttingDown || !room.running) return null;
    store.log(id, `world_shot failed: ${e.message}`);
    post({ from: 'system', kind: 'error', by: id, text: tx().shotFail(id, e.message) });
    return null;
  }
}

// Selected official full art is the appearance reference for active personas.
// Only legacy participants without a persona may use the previous sheet/avatar paths.
function personaAssetPath(id, value) {
  if (typeof value !== 'string' || !value.startsWith(`/assets/characters/${id}/`)) return null;
  if (!/^\/assets\/characters\/[a-z0-9_-]+\/[a-zA-Z0-9_-]+\.png$/.test(value)) return null;
  return value;
}
function personaSkin(id, skin = {}) {
  const c = skin.avatarCrop;
  const crop = c && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(c[k]))
    && c.x >= 0 && c.y >= 0 && c.width > 0 && c.height > 0 && c.x + c.width <= 1 && c.y + c.height <= 1
    ? { x: c.x, y: c.y, width: c.width, height: c.height } : null;
  return { key: skin.key, label: skin.label, full: personaAssetPath(id, skin.full), avatar: personaAssetPath(id, skin.avatar), ...(crop ? { avatarCrop: crop } : {}) };
}
const missingPersonaArt = new Set();
function sheetOf(who) {
  const w = String(who ?? '').trim().toLowerCase();
  const id = [...AI_IDS, 'grok', 'dev'].find((x) => [x, MEMBERS[x]?.name, ...(MEMBERS[x]?.aliases || [])].some((a) => a && a.toLowerCase() === w));
  if (!id) return null;
  const persona = personaFor(id);
  if (persona) {
    const rel = personaAssetPath(id, persona.skin?.full);
    if (rel) {
      try {
        const file = fs.realpathSync(path.join(ROOT, 'public', rel));
        const base = path.join(ROOT, 'public', 'assets', 'characters', id) + path.sep;
        if (file.startsWith(base) && fs.statSync(file).isFile()) return file;
      } catch { /* An active character must never fall back to an old AI sheet. */ }
    }
    if (!missingPersonaArt.has(id)) {
      missingPersonaArt.add(id);
      console.warn(`[characters] Missing or unsafe selected full art for ${id}; no image reference supplied.`);
    }
    return null;
  }
  const cands = [
    path.join(ROOT, 'assets', 'sheets', `${id}_sheet.png`),
    path.join(ROOT, 'public', 'avatars', `${id}.png`),
    path.join(ROOT, 'public', 'avatars', `${id}.webp`),
  ];
  return cands.find((f) => fs.existsSync(f)) || null;
}

// Resident snapshots share photo references/cadence even if a model omits the flag.
function imageRequest(v, requester) {
  const members = AI_IDS.map(id => {
    const persona = personaFor(id);
    return { id, name: MEMBERS[id].name, aliases: MEMBERS[id].aliases,
      publicAliases: (persona?.aliases || []).filter(alias => !persona.legacyAliases.includes(alias)) };
  });
  v = normalizeHomePhotoRequest(v, { homeId: world.home?.id, members });
  if (v && typeof v === 'object' && Object.hasOwn(v, 'photocard') && v.photocard !== false) {
    return parsePhotocardRequest(v, { requester, sanitize: publicIdentity.text, members });
  }
  if (typeof v === 'string') return v.trim() ? { prompt: v.slice(0, 1200) } : null;
  if (!v || typeof v !== 'object' || !String(v.prompt ?? '').trim()) return null;
  return { prompt: String(v.prompt).slice(0, 1200), ref: v.ref ? String(v.ref) : null, saveAs: v.save_as ? String(v.save_as) : null };
}

async function startImage(a, req) {
  if (shuttingDown) return;
  if (req.photocard === true) return startPhotocard(a, req);
  const { prompt } = req;
  const id = a.id;
  const wait = cfg.imageCooldownSec * 1000 - (Date.now() - a.lastImageAt);
  if (a.imageBusy || wait > 0) {
    post({ from: 'system', kind: 'error', by: id, text: tx().cantDraw(id, a.imageBusy, Math.ceil(wait / 1000)) });
    return;
  }
  const imageToken = {};
  a.imageToken = imageToken;
  a.imageBusy = true;
  pushMembers();
  post({ from: 'system', kind: 'drawing', by: id, text: tx().drawing(id) });
  try {
    const refSheet = req.ref ? sheetOf(req.ref) : null;
    const res = await adapters.image(id, prompt, { refSheet });
    if (a.imageToken !== imageToken) return;
    store.log(id, `image ok=${res.ok} ref=${refSheet ? path.basename(refSheet) : '-'} ${res.file || res.detail}`);
    if (res.ok) {
      const rel = `images/${saveImageFile(store.abs('images'), { source: res.file })}`;
      store.touchMeta(rel, id, true);
      post({ from: id, text: '', attach: { path: rel, prompt } });
      if (req.saveAs) {
        // save_as gets the generator's extension (it may hand back a .jpg).
        const want = req.saveAs.replace(/\.(png|jpe?g|webp|gif)$/i, '') + path.posix.extname(rel);
        try {
          const dst = saveSticker(rel, want, id);
          post({ from: 'system', kind: 'file', by: id, file: dst, text: tx().stickerSaved(id, dst) });
        } catch (e) {
          post({ from: 'system', kind: 'error', by: id, text: tx().stickerFail(id, e.message) });
        }
      }
      broadcast('ws', store.listFiles());
    } else {
      post({ from: 'system', kind: 'error', by: id, text: tx().drawFail(id) });
    }
  } catch (e) {
    if (a.imageToken === imageToken) {
      store.log(id, `image error ${e.message}`);
      post({ from: 'system', kind: 'error', by: id, text: tx().drawFail(id) });
    }
  } finally {
    if (a.imageToken === imageToken) {
      delete a.imageToken;
      a.imageBusy = false;
      a.lastImageAt = Date.now();
      pushMembers();
    }
  }
}

function startPhotocard(a, req) {
  if (!room.running || !cfg.imageGen || !avail.gpt || !AI_IDS.includes(a.id)) return { accepted: false, reason: 'off' };
  if (a.imageBusy) return { accepted: false, reason: 'busy' };
  const avatars = world.avatarView();
  if (photoSubjectsArriving(avatars, req.subjects)) return { accepted: false, reason: 'moving' };
  const referenceRoot = path.join(ROOT, 'public', 'assets', 'characters');
  // Reject unsafe/missing art before consuming queue space. Resolve again at launch.
  try { resolvePhotocardReferences(req.subjects, { root: referenceRoot, sheetOf }); }
  catch { store.log(a.id, 'photocard rejected: references unavailable'); return { accepted: false, reason: 'references' }; }
  photocardQueue ??= new PhotocardQueue({
    enabled: () => !shuttingDown && room.running && cfg.imageGen && avail.gpt,
    memberCooldownMs: Math.max(240000, (Number(cfg.imageCooldownSec) || 0) * 1000),
    admissionCooldownMs: world.home?.id === 'mulgyeol-maru' ? HOME_PHOTO_GAP_MS : 0,
    lastPhotoAt: lastHomePhotoAt(store.messages || store.recent(2000)),
    singleFlight: world.home?.id === 'mulgyeol-maru',
    sceneDuplicateMs: world.home?.id === 'mulgyeol-maru' ? 45 * 60 * 1000 : 0,
    run: async job => {
      const member = agents[job.owner];
      if (!job.current() || member.imageBusy) return;
      member.photocardToken = job;
      member.imageBusy = true;
      pushMembers();
      try {
        const refSheets = resolvePhotocardReferences(job.request.subjects, { root: referenceRoot, sheetOf });
        const faceReferenceNames = refSheets.slice(job.request.subjects.length).map(file =>
          job.request.subjects.find(subject => subject.id === path.basename(path.dirname(file))).name);
        const prompt = buildPhotocardPrompt(job.request, { sanitize: publicIdentity.text, context: job.request.context, faceReferenceNames });
        post({ from: 'system', kind: 'drawing', by: member.id, text: tx().photographing(member.id) });
        const res = await adapters.image('gpt', prompt, { photocard: true, effort: job.request.effort, refSheets, referenceRoot });
        if (!job.current()) return;
        if (!res.ok) throw new Error('photocard_failed');
        const rel = `images/${saveImageFile(store.abs('images'), { source: res.file })}`;
        store.touchMeta(rel, member.id, true);
        // Album = existing saved workspace attachments. References/routing stay private.
        post({ from: member.id, text: '', attach: { path: rel, prompt: job.request.prompt, photocard: true,
          photoSubjects: job.request.subjects.map(subject => subject.id) } });
        broadcast('ws', store.listFiles());
      } catch {
        if (job.current()) {
          store.log(member.id, 'photocard failed');
          post({ from: 'system', kind: 'error', by: member.id, text: tx().drawFail(member.id) });
        }
      } finally {
        if (member.photocardToken === job) {
          delete member.photocardToken;
          member.imageBusy = false;
          member.lastImageAt = Date.now();
          if (job.current()) pushMembers();
        }
      }
    },
  });
  const context = store.recent(12).filter(m => m.from !== 'system' && m.from !== 'dev' && m.text).slice(-4).map(m => `${name(m.from)}: ${m.text}`);
  // Busy/duplicate/cooldown responses are deliberately silent, not repeated chat errors.
  const worldSnapshot = photocardWorldSnapshot(req.subjects, avatars);
  const livingSnapshot = photocardLivingSnapshot(living?.view(), { nameOf: name, avatars, home: world.home, blocks: world.blocks, subjects: req.subjects });
  return photocardQueue.enqueue(a.id, { ...req, context, worldSnapshot, livingSnapshot,
    sceneKey: photocardSceneKey(worldSnapshot, world.home) });
}

function invalidatePhotocards() {
  photocardQueue?.invalidate();
  for (const a of Object.values(agents)) {
    if (!a.photocardToken && !a.imageToken) continue;
    delete a.photocardToken;
    delete a.imageToken;
    a.imageBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Room controls

function startRoom() {
  const now = Date.now();
  try { living?.resume(now); } catch { living = null; }
  room.running = true;
  room.sleeping = false;
  room.startedAt = now;
  room.lastUserAt = now;
  for (const id of AI_IDS) {
    const a = agents[id];
    a.offlineUntil = 0;
    a.fails = 0;
    a.idleStreak = 0;
    // someone should speak up soon after the room opens
    a.idleAt = now + rand(4, 25) * 1000;
  }
  // Opening a room that has been quiet for a while: the first pick comes within seconds.
  // (Not after a quick server restart mid-conversation.)
  const lastReal = [...store.recent(60)].reverse().find((m) => m.from !== 'system');
  spark.quick = !lastReal || now - lastReal.ts > 10 * 60000;
  broadcast('living', publicLiving(living?.view(), publicIdentity));
  store.saveState();
  pushRoom();
  pushMembers();
}

function stopRoom(sleeping = false) {
  try { living?.pause(); } catch { living = null; }
  broadcast('living', publicLiving(living?.view(), publicIdentity));
  room.running = false;
  invalidatePhotocards();
  room.sleeping = sleeping;
  for (const a of Object.values(agents)) {
    if (a.readBatch) { a.wakeAt = null; a.reason = null; a.readBatch = null; }
  }
  killAll();
  store.saveState();
  pushRoom();
  pushMembers();
}

function sleepRoom() {
  post({ from: 'system', kind: 'sleep', text: tx().slept() });
  stopRoom(true);
}

// ---------------------------------------------------------------------------
// HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Workspace files are written by the AIs: serve them sandboxed with no network access.
const WS_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; sandbox allow-scripts";

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 200000) {
  return readJsonBody(req, limit);
}

// The user's photo attachments: base64 in the /api/send JSON, stored under images/.
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_BODY_LIMIT = Math.ceil(UPLOAD_MAX_BYTES * 4 / 3) + 16384;

// Trust the bytes, not the file name: png / jpeg / gif / webp only.
function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return '.gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

// Returns the workspace path of the saved image, or throws with a message for the user.
function saveUpload(img) {
  const b64 = String(img?.data ?? '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error(tx().imgEmpty);
  if (buf.length > UPLOAD_MAX_BYTES) throw new Error(tx().imgTooBig(UPLOAD_MAX_BYTES / 1048576));
  const ext = sniffImage(buf);
  if (!ext) throw new Error(tx().imgType);
  if (store.listFiles().length >= 300) throw new Error(tx().imgLimit);
  const rel = `images/${saveImageFile(store.abs('images'), { data: buf, extension: ext })}`;
  store.touchMeta(rel, 'user', true);
  return rel;
}

// Members without image vision get a text description of each photo. Their turns
// wait for it for a little while (see tick) so they don't answer before it exists.
const DESC_WAIT_MS = 45000;
const describing = new Set();
async function describeUpload(msg) {
  describing.add(msg.id);
  try {
    const res = await adapters.describeImage(store.abs(msg.attach.path));
    store.log('describe', `#${msg.id} ${msg.attach.path} ok=${res.ok} ${res.ok ? res.text : res.detail}`);
    if (res.ok) {
      const updated = store.setAttachDesc(msg.id, res.text);
      if (updated) broadcast('msgupdate', updated);
    }
  } catch (e) {
    store.log('describe', `#${msg.id} error ${e.message}`);
  } finally {
    describing.delete(msg.id);
  }
}
const waitingForDesc = (fresh, now) => fresh.some((m) => describing.has(m.id) && now - m.ts < DESC_WAIT_MS);

// Only the room page itself may call the API (blocks workspace mini-apps and other sites).
function trustedPost(req) {
  return admin.trustedPost(req);
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/health') return sendJson(res, shuttingDown ? 503 : 200, { ok: !shuttingDown });
  if (req.method === 'GET' && p === '/api/topics') return sendJson(res, 200, publicIdentity.project(topics.publicView()));
  if (req.method === 'GET' && p === '/api/admin/topics') {
    if (!admin.isAdmin(req)) return sendJson(res, 401, { error: '관리자 로그인이 필요합니다.' });
    return sendJson(res, 200, { items: topics.listAdmin() });
  }
  if (req.method === 'GET' && p === '/api/session') return sendJson(res, 200, admin.session(req));
  if (req.method === 'GET' && (p === '/api/admin/settings' || p === '/api/usage')) {
    if (!admin.isAdmin(req)) return sendJson(res, 401, { error: '관리자 로그인이 필요합니다.' });
    return sendJson(res, 200, p === '/api/usage' ? batteryView(usageView(), AI_IDS) : publicIdentity.project(roomView()));
  }
  // Explicit raw diagnostics only. Normal browser state/SSE always uses public IDs.
  if (req.method === 'GET' && p.startsWith('/api/admin/raw/')) {
    if (!admin.isAdmin(req)) return sendJson(res, 401, { error: '관리자 로그인이 필요합니다.' });
    if (p === '/api/admin/raw/state') return sendJson(res, 200, { room: roomView(), members: AI_IDS.map(memberView), usage: usageView() });
    if (p === '/api/admin/raw/plans') return sendJson(res, 200, plans.view());
    if (p === '/api/admin/raw/file') {
      try {
        const rel = store.safeRel(url.searchParams.get('path'));
        if (!containedFile(store.wsDir, store.abs(rel))) throw new Error('not found');
        return sendJson(res, 200, store.readFile(rel));
      } catch { return sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' }); }
    }
    return sendJson(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, {
      session: admin.session(req),
      room: publicRoom(roomView(), publicIdentity),
      members: AI_IDS.map(id => publicMember(memberView(id), publicIdentity)),
      messages: store.recent(80).map(m => publicMessage(m, getLang(), publicIdentity, publicWorkspace.publicPath)),
      files: publicFiles(),
      sleeps: sleepStates(AI_IDS.map(memberView)),
      liar: publicIdentity.project(liarSession.view()),
    });
  }
  if (req.method === 'GET' && p === '/api/world') {
    return sendJson(res, 200, publicIdentity.world(world.view()));
  }
  if (req.method === 'GET' && p === '/api/living') {
    return sendJson(res, living ? 200 : 503, publicLiving(living?.view(), publicIdentity));
  }
  if (req.method === 'GET' && p === '/api/plans') {
    return sendJson(res, 200, publicPlans(plans.view(), publicIdentity));
  }
  if (req.method === 'GET' && p === '/api/liar') {
    return sendJson(res, liarSession.engine ? 200 : 503, publicIdentity.project(liarSession.view()));
  }
  if (req.method === 'GET' && p === '/api/notes') {
    return sendJson(res, 200, publicIdentity.project(Object.fromEntries(AI_IDS.map((id) => [id, store.readNote(id)]))));
  }
  if (req.method === 'GET' && p === '/api/file') {
    try {
      return sendJson(res, 200, publicWorkspace.read(url.searchParams.get('path')).value);
    } catch (e) {
      return sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' });
    }
  }
  if (req.method === 'GET' && p === '/api/history') {
    const before = Number(url.searchParams.get('before')) || Infinity;
    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 60;
    let older;
    try { older = await store.historyBefore(before, limit); }
    catch (error) {
      if (error.code !== 'HISTORY_BUSY') throw error;
      res.setHeader('Retry-After', '2'); return sendJson(res, 503, { error: '이전 대화를 불러오는 중입니다. 잠시 후 다시 이용해 주세요.' });
    }
    return sendJson(res, 200, { messages: older.map(m => publicMessage(m, getLang(), publicIdentity, publicWorkspace.publicPath)) });
  }

  if (req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });
  if (!trustedPost(req)) return sendJson(res, 403, { error: '허용되지 않은 요청입니다.' });
  if (p === '/api/topics/submit') {
    if (!submitLimit.take(addressOf(req)) || !totalSubmitLimit.take('all')) {
      res.setHeader('Retry-After', '600'); return sendJson(res, 429, { error: '제보가 많습니다. 잠시 후 다시 보내 주세요.' });
    }
  try {
    const input = await readBody(req, 8192);
      if (shuttingDown) return sendJson(res, 503, { error: '서버를 재시작하고 있습니다.' });
      const result = topics.submit(input);
      const mail = cfg.topics.formspreeId
        ? await deliverTopicMail(topics, result.id, { formId: cfg.topics.formspreeId }) : { status: 'saved' };
      return sendJson(res, 202, { accepted: true, duplicate: result.duplicate, mailStatus: mail.status });
    } catch (error) {
      return sendJson(res, error instanceof TopicError ? error.status : 400, { error: error instanceof TopicError ? error.message : '제보 내용을 확인해 주세요.' });
    }
  }
  const login = p === '/api/admin/login';
  if (!login && !admin.isAdmin(req)) return sendJson(res, 401, { error: '관리자 로그인이 필요합니다.' });
  let body;
  try {
    body = await readBody(req, login ? 4096 : p === '/api/send' ? UPLOAD_BODY_LIMIT : undefined);
  } catch (e) {
    return sendJson(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? '요청 내용이 너무 큽니다.' : '요청 형식을 확인해 주세요.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: '요청 형식을 확인해 주세요.' });
  if (login) {
    const result = await admin.login(req, body.password);
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    res.setHeader('Set-Cookie', result.cookie);
    return sendJson(res, 200, result.session);
  }
  // A session can expire or be revoked while an upload body is arriving.
  if (shuttingDown) return sendJson(res, 503, { error: '서버를 재시작하고 있습니다.' });
  if (!admin.isAdmin(req)) return sendJson(res, 401, { error: '관리자 로그인이 필요합니다.' });
  if (p === '/api/admin/topics') {
    try {
      if (body.action === 'submit') {
        const result = topics.submit(body, { kind: body.kind === 'ercraft' ? 'ercraft' : 'owner' });
        const mail = cfg.topics.formspreeId
          ? await deliverTopicMail(topics, result.id, { formId: cfg.topics.formspreeId }) : { status: 'saved' };
        return sendJson(res, 200, { accepted: true, duplicate: result.duplicate, mailStatus: mail.status });
      }
      const result = topics.review(body);
      return sendJson(res, 200, result);
    } catch (error) { return sendJson(res, error instanceof TopicError ? error.status : 500, { error: error instanceof TopicError ? error.message : '제보를 저장하지 못했습니다.' }); }
  }
  if (p === '/api/admin/logout') {
    res.setHeader('Set-Cookie', admin.logout(req));
    for (const c of clients.keys()) refreshClientSession(c);
    return sendJson(res, 200, { role: 'viewer', authenticated: false });
  }

  if (p === '/api/send' && body.sticker) {
    let rel;
    try {
      const copy = publicWorkspace.read(body.sticker);
      if (copy.value.image) rel = stickerPath(publicWorkspace.resolve(body.sticker).path);
    } catch { /* Unknown, private or unsafe public attachment. */ }
    if (!rel || !fs.existsSync(store.abs(rel))) return sendJson(res, 400, { error: tx().noSticker });
    room.lastUserAt = Date.now();
    const msg = post({ from: 'user', text: '', attach: { path: rel, sticker: true } });
    if (!room.running && room.sleeping) startRoom();
    return sendJson(res, 200, { ok: true, msg: publicMessage(msg, getLang(), publicIdentity, publicWorkspace.publicPath), running: room.running });
  }
  if (p === '/api/send') {
    let text = String(body.text ?? '').trim().slice(0, 4000);
    const hasImage = !!body.image?.data;
    if (!text && !hasImage) return sendJson(res, 400, { error: 'empty' });
    room.lastUserAt = Date.now();
    // "/boost @멤버 [할 말]": that member's next turn runs on its boost settings.
    const cmd = Router.parseCommand(text);
    if (cmd) {
      if (!cmd.ids.length) return sendJson(res, 400, { error: tx().boostWho });
      if (boostMode() === 'off') return sendJson(res, 400, { error: tx().boostOff });
      const ids = cmd.ids.filter((id) => hasBoost(id));
      if (!ids.length) return sendJson(res, 400, { error: tx().boostNone });
      for (const id of ids) router.arm(id);
      post({ from: 'system', kind: 'deep', text: tx().boostArmed(ids.map(name).join(tx().sep)) });
      if (!room.running && room.sleeping) startRoom();
      if (!cmd.rest && !hasImage) return sendJson(res, 200, { ok: true, running: room.running });
      text = `${ids.map((id) => `@${MEMBERS[id].name}`).join(' ')} ${cmd.rest}`.trim();
    }
    let attach;
    if (hasImage) {
      try { attach = { path: saveUpload(body.image), upload: true }; } catch (e) { return sendJson(res, 400, { error: e.message }); }
      broadcast('ws', store.listFiles());
    }
    const replyTo = Number(body.replyTo);
    const msg = post({ from: 'user', text, replyTo: store.getMessage(replyTo) ? replyTo : undefined, attach });
    if (attach) describeUpload(msg);
    if (!room.running && room.sleeping) startRoom();
    return sendJson(res, 200, { ok: true, msg: publicMessage(msg, getLang(), publicIdentity, publicWorkspace.publicPath), running: room.running });
  }
  if (p === '/api/react') {
    const emoji = String(body.emoji ?? '').slice(0, 8);
    if (emoji) react(Number(body.id), 'user', emoji);
    room.lastUserAt = Date.now();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/room') {
    if (typeof body.speed === 'string' && SPEEDS[body.speed]) room.speed = body.speed;
    if (['auto', 'manual', 'off'].includes(body.boostMode)) room.boostMode = body.boostMode;
    if (Number.isFinite(body.autoSleepMin)) room.autoSleepMin = Math.max(0, Math.min(600, body.autoSleepMin));
    if (body.running === true && !room.running) startRoom();
    else if (body.running === false && room.running && !shuttingDown) stopRoom(false);
    store.saveState();
    pushRoom();
    pushMembers();
    return sendJson(res, 200, publicIdentity.project(roomView()));
  }
  if (p === '/api/usage/refresh') {
    const fresh = Date.now() - usage.lastPoll < 15000;
    if (!usage.polling && !fresh) usage.pollAll();
    return sendJson(res, 200, { ok: true, polling: true });
  }
  if (p === '/api/member') {
    body.id = internalMemberId(body.id);
    if (!AI_IDS.includes(body.id) || typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: '멤버 설정을 확인해 주세요.' });
    if (AI_IDS.includes(body.id) && typeof body.enabled === 'boolean') {
      room.enabled[body.id] = body.enabled;
      const a = agents[body.id];
      if (body.enabled) {
        a.offlineUntil = 0;
        a.fails = 0;
        a.seen = store.lastId;
        post({ from: 'system', kind: 'join', by: body.id, text: tx().joined(body.id) });
      } else {
        post({ from: 'system', kind: 'leave', by: body.id, text: tx().left(body.id) });
      }
      store.saveState();
      pushMembers();
    }
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function containedFile(root, file) {
  try {
    const base = fs.realpathSync(root), actual = fs.realpathSync(file);
    const rel = path.relative(base, actual);
    return !!rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel) && fs.statSync(actual).isFile();
  } catch { return false; }
}

function publicFiles() {
  return publicWorkspace.list();
}

// Pages go out with the room language in <html lang>, which public/i18n.js translates from.
function serveHtml(res, file) {
  fs.readFile(file, 'utf8', (err, text) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const body = Buffer.from(mountHtml(text.replace(/<html lang="[a-z]+">/, `<html lang="${getLang()}">`), cfg.basePath));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}

// Decoded request path, or null for a malformed one (e.g. a stray "%").
function pathOf(url) {
  try { return decodeURIComponent(url.pathname); } catch { return null; }
}

// Exact request names prevent Windows short-name/alternate-path aliases from
// falling through to internal portraits, manifests, or future private assets.
const PUBLIC_STATIC_PATHS = new Set(['/', '/admin', '/licenses', '/index.html', '/licenses.html',
  '/app.js', '/i18n.js', '/style.css', '/world.html', '/world-materials.js', '/world-home.js', '/world-diorama.js', '/living-view.js',
  '/presentation.js', '/persona-client.js', '/shared-images.js', '/timeline-window.js', '/base-path.js', '/topics', '/topics.html', '/topics.js', '/icon.ico', '/ercraft-symbol.png']);

PUBLIC_STATIC_PATHS.add('/liar-panel.js');

async function handleRequest(req, res) {
  // Includes early errors/redirects: tokenless origin errors must never poison an edge cache.
  res.setHeader('Cache-Control', 'no-store');
  if (!proxyAccess(req, { required: cfg.publicGateway, secret: process.env.CHATROOM_PROXY_TOKEN })) {
    res.setHeader('X-ERCraft-Chat-Gate', 'required');
    res.writeHead(404); res.end(); return;
  }
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400); res.end(); return; }
  const originalPath = pathOf(url);
  if (originalPath === null) { res.writeHead(400); res.end(); return; }
  if (cfg.basePath) {
    if (originalPath === cfg.basePath) { res.writeHead(308, { Location: cfg.basePath + '/' + url.search }); res.end(); return; }
    if (url.pathname.startsWith(cfg.basePath + '/')) url.pathname = url.pathname.slice(cfg.basePath.length);
    else {
      const localHost = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(req.headers.host || '') && loopbackAddress(req.socket.remoteAddress);
      if (localHost && !req.headers['x-forwarded-host'] && req.method === 'GET' && PUBLIC_STATIC_PATHS.has(originalPath)) {
        res.writeHead(308, { Location: cfg.basePath + originalPath + url.search }); res.end(); return;
      }
      if (!(localHost && originalPath?.startsWith('/api/dev/'))) { res.writeHead(404); res.end(); return; }
    }
  }
  const p = pathOf(url);
  if (p === null) { res.writeHead(400); res.end(); return; }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (shuttingDown) return sendJson(res, 503, { error: '서버를 재시작하고 있습니다.' });
  if (!readLimit.take(addressOf(req)) || !totalReadLimit.take('all')) {
    res.setHeader('Retry-After', '60'); return sendJson(res, 429, { error: '요청이 많습니다. 잠시 후 다시 이용해 주세요.' });
  }
  try {
    if (p === '/events') {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      if (!eventHub.add(req, res, addressOf(req))) { res.setHeader('Retry-After', '15'); return sendJson(res, 503, { error: '접속자가 많습니다. 잠시 후 다시 연결해 주세요.' }); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      eventHub.write(res, 'retry: 5000\n\n');
      const session = admin.session(req);
      clientAuth.set(res, { req, role: session.role });
      eventHub.write(res, `event: liar\ndata: ${JSON.stringify(publicIdentity.project(liarSession.view()))}\n\n`);
      eventHub.write(res, `event: session\ndata: ${JSON.stringify(session)}\n\n`);
      return;
    }
    if (activeRequests >= cfg.network.maxRequests) return sendJson(res, 503, { error: '요청을 처리 중입니다. 잠시 후 다시 이용해 주세요.' });
    activeRequests++;
    let released = false;
    const release = () => { if (!released) { released = true; activeRequests--; } };
    res.once('finish', release); res.once('close', release);
    if (p.startsWith('/api/dev/')) {
      if (!loopbackAddress(req.socket.remoteAddress) || !/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(req.headers.host || '')
          || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['cf-connecting-ip']) { res.writeHead(404); res.end(); return; }
      await devBridge.handle(req, res, url, { sendJson, readBody }); return;
    }
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (p.startsWith('/ws/')) {
      try {
        const copy = publicWorkspace.read(p.slice(4));
        let body=copy.body,type=copy.type;
        if(url.searchParams.get('preview')==='1' && copy.value.image && type==='image/png') {
          try {body=await imagePreviews.get(body);type='image/jpeg';}
          catch {res.setHeader('Retry-After','3');res.writeHead(503);res.end();return;}
        }
        if(res.destroyed)return;
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': WS_CSP, 'X-Content-Type-Options': 'nosniff', ...(copy.value.image ? { 'X-Image-Notice': PUBLIC_IMAGE_NOTICE } : {}) });
        res.end(req.method === 'HEAD' ? undefined : body); return;
      } catch { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return;
      }
    }
    if (p === '/LICENSE') return serveStatic(res, path.join(ROOT, 'LICENSE'), { 'Content-Type': 'text/plain; charset=utf-8' });
    // Block case/encoding/backslash variants on case-insensitive hosts as well.
    const normalized = path.posix.normalize(p.replace(/\\/g, '/')).toLowerCase();
    if (normalized.startsWith('/avatars/') || normalized === '/assets/characters' || normalized.startsWith('/assets/characters/')) {
      const asset = resolveCharacterAsset(p);
      if (asset) {
        const imageRoot = path.join(ROOT, 'public', ...(url.searchParams.get('preview') === '1' ? ['previews'] : []));
        const file = path.join(imageRoot, asset);
        if (containedFile(path.join(imageRoot, 'assets', 'characters'), file)) {
          try {
            const body = readPublicPng(file);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Image-Notice': PUBLIC_IMAGE_NOTICE });
            res.end(req.method === 'HEAD' ? undefined : body); return;
          } catch { /* Unsafe/unsupported image metadata fails closed. */ }
        }
      }
      res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (!PUBLIC_STATIC_PATHS.has(p)) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return; }
    const rel = p === '/' || p === '/admin' ? 'index.html' : p === '/licenses' ? 'licenses.html' : p === '/topics' ? 'topics.html' : p.slice(1);
    const file = path.normalize(path.join(ROOT, 'public', rel));
    if (!containedFile(path.join(ROOT, 'public'), file)) { res.writeHead(404); res.end(); return; }
    if (file.endsWith('.html')) return serveHtml(res, file);
    return serveStatic(res, file, /^\/assets\/characters\/[a-z0-9_-]+\/[a-zA-Z0-9_-]+\.png$/.test(p)
      ? { 'Cache-Control': 'public, max-age=86400' } : {});
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: '요청 처리 중 오류가 발생했습니다.' });
    else res.destroy();
  }
}

const server = http.createServer(handleRequest);
server.headersTimeout = 15000;
server.requestTimeout = 20000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 64;
server.maxConnections = 512;

// External listener: login first, and the dev bridge API does not exist here at all.
let extServer = null;
if (cfg.external.enabled) {
  const gate = new ExternalGate(HOME_DIR, { log: (t) => store.log('external', t) });
  const secure = cfg.external.https !== false;
  const onExternal = async (req, res) => {
    try {
      const url = new URL(req.url, 'https://external');
      const p = pathOf(url);
      if (p === null) { res.writeHead(400); res.end(); return; }
      const localPath = cfg.basePath && p.startsWith(cfg.basePath + '/') ? p.slice(cfg.basePath.length) : p;
      if (path.posix.normalize(localPath.replace(/\\/g, '/')).toLowerCase().startsWith('/api/dev')) { res.writeHead(404); res.end('not found'); return; }
      if (await gate.handle(req, res, p, { secure })) return;
      await handleRequest(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  };
  try {
    extServer = secure ? https.createServer(gate.tls(), onExternal) : http.createServer(onExternal);
    extServer.on('error', (e) => console.log(tx().extPortFail(e.message)));
    extServer.listen(cfg.external.port, cfg.external.host, () => {
      console.log(tx().extOn(secure ? 'https' : 'http', cfg.external.port));
    });
  } catch (e) {
    console.log(tx().extFail(e.message));
  }
}

// First run: say hello once.
if (!store.messages.length) {
  post({ from: 'system', kind: 'welcome', text: tx().welcome(AI_IDS.map((id) => MEMBERS[id].name).join(tx().sep)) });
}

// Resume after a restart only if the room was on; preserve a sleeping room.
if (room.running) startRoom();

// Photos posted before descriptions existed (or while the server was down): describe the
// last few, one at a time.
(async () => {
  const todo = store.recent(300).filter((m) => m.attach?.upload && !m.attach.desc && fs.existsSync(store.abs(m.attach.path))).slice(-5);
  for (const m of todo) { if (shuttingDown) break; await describeUpload(m); }
})();

setInterval(tick, 500);

// ---------------------------------------------------------------------------
// Automatic usage polling follows room activity. Paused rooms keep cached usage;
// the authenticated manual refresh remains available without starting the room.

const usage = new UsageMonitor(HOME_DIR, adapters.bins, { onUpdate: () => broadcast('usage', usageView()) });
function usageView() {
  const v = usage.view();
  v.deepseek = { windows: [], plan: 'Hive API', note: 'Hive 별도 토큰 과금 · 잔액 미조회 · 이 방 호출 토큰은 data/hive-usage.jsonl에 기록' };
  const now = Date.now();
  for (const id of AI_IDS) {
    const calls30 = agents[id].callTimes.filter((t) => now - t < 30 * 60000).length;
    v[id] = v[id] ? { ...v[id], calls30 } : { calls30, windows: [] };
  }
  return v;
}
let usagePushTimer = null;
function pushUsageSoon() {
  if (usagePushTimer) return;
  usagePushTimer = setTimeout(() => { usagePushTimer = null; broadcast('usage', usageView()); }, 2000);
}
setInterval(() => {
  if (shuttingDown || !room.running) return;
  const every = cfg.usagePollSec * 1000;
  if (!usage.polling && Date.now() - usage.lastPoll >= every) usage.pollAll();
}, 10000);
if (room.running) usage.pollAll();

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
  console.log(tx().portBusy(cfg.port, e.code));
  console.log(tx().portHint);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  const miss = AI_IDS.filter((id) => !avail[id]);
  const url = `http://localhost:${cfg.port}${cfg.basePath}/`;
  console.log(tx().listening(url));
  fs.writeFileSync(path.join(HOME_DIR, 'data', 'server.pid'), String(process.pid));
  if (process.connected && process.env.CHATROOM_SERVICE_INSTANCE) process.send({ type: 'service:ready', protocol: 1, instanceId: process.env.CHATROOM_SERVICE_INSTANCE, pid: process.pid }, () => {});
  console.log(`CLI: ${JSON.stringify(adapters.bins)}`);
  if (miss.length) {
    console.log(tx().cliMissing(miss.join(', ')));
    console.log(tx().cliHint);
  }
  // start.bat / start.sh pass --open: show the room in the default browser.
  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { living?.pause(); } catch { console.error('Living clock could not be paused.'); }
  invalidatePhotocards();
  devBridge.close();
  eventHub.close();
  server.close(); extServer?.close();
  clearTimeout(saveTimer); clearTimeout(usagePushTimer);
  // Let owned calls settle; never abandon a still-live child or force a process
  // tree down. The supervisor keeps ownership if this exceeds its stop deadline.
  void drainShutdown();
}
async function drainShutdown() {
  while (activeRequests || imagePreviews.busy || runningChildren.size || usage.polling || describing.size
    || Object.values(agents).some(a => a.busy || a.imageBusy) || photocardQueue?.active) await sleep(100);
  try {
    world.flush();
    for (const id of AI_IDS) store.state.seen[id] = agents[id].seen;
    store.state.householdFlow = householdFlow.snapshot();
    store.saveState();
    process.exit(0);
  } catch { console.error('Service shutdown could not flush persisted state'); process.exit(1); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', message => {
  const instanceId = process.env.CHATROOM_SERVICE_INSTANCE;
  if (!instanceId || message?.instanceId !== instanceId) return;
  if (message.type === 'shutdown') shutdown();
  else if (message.type === 'service:health' && process.connected) process.send({ type: 'service:health', requestId: message.requestId, instanceId, pid: process.pid, ready: !shuttingDown, roomRunning: room.running }, () => {});
});
process.on('disconnect', () => { if (process.env.CHATROOM_SERVICE_INSTANCE) shutdown(); });
