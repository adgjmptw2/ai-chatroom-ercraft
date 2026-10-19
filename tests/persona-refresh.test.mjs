import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { PERSONAS, PERSONA_MEME_BANK, DEV_PERSONA, devPersonaCue, personaBrief, personaTurnCue, selectPersonaReferences } from '../lib/personas.mjs';
import { AI_IDS, MEMBERS, DEV, displayName, mentionsDev } from '../lib/members.mjs';
import { formatMemberSpeech } from '../lib/member-speech.mjs';
import { publicMember } from '../lib/public-view.mjs';
import { getLang, setLang } from '../lib/i18n.mjs';
import { DevBridge, devChainState, developerPromptCue } from '../lib/dev.mjs';
import { DICT, lang as clientLang } from '../public/i18n.js';
import { setPersonaMembers, memberName, memberColor, memberAccentColor, aliasesFor, personaSpec, avatarSpec, avatarMarkup, drawAvatar, validCrop } from '../public/persona-client.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const compiledEvidence = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/persona-meme-bank.json'), 'utf8'));

test('provider IDs and capabilities stay stable while colors and localized developer names change', () => {
  assert.deepEqual(AI_IDS, ['claude', 'gpt', 'deepseek', 'gemini']);
  assert.deepEqual(AI_IDS.map((id) => MEMBERS[id].color), ['#c34b83', '#258552', '#4f65de', '#957100']);
  assert.deepEqual(AI_IDS.map((id) => MEMBERS[id].imageGen), [false, true, false, true]);
  assert.equal(DEV.id, 'dev');
  assert.equal(DEV.persona, DEV_PERSONA);
  assert.equal(AI_IDS.includes(DEV.id), false);
  const originalLang = getLang();
  try {
    for (const [lang, name] of Object.entries(DEV_PERSONA.names)) {
      setLang(lang);
      assert.equal(displayName('dev'), name);
      assert.equal(DICT[lang]['dev.name'], name);
      assert.ok(DICT[lang]['dev.online'].includes(`@${name}`));
      assert.ok(devPersonaCue().startsWith(name));
    }
  } finally { setLang(originalLang); }
});

test('the refreshed colors meet white contrast and remain visible on the existing dark surfaces', () => {
  const luminance = (hex) => hex.match(/[a-f0-9]{2}/ig).map((s) => parseInt(s, 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const darkNameColor = (hex) => '#' + hex.match(/[a-f0-9]{2}/ig)
    .map((s) => Math.round(parseInt(s, 16) * 0.75 + 255 * 0.25).toString(16).padStart(2, '0')).join('');
  for (const id of ['claude', 'gemini', 'gpt']) {
    assert.ok(contrast(MEMBERS[id].color, '#ffffff') >= 4.5, `${id} on white`);
    for (const bg of ['#f7f7f9', '#f1f2f6', '#12151b', '#0f1217', '#1d222c']) {
      assert.ok(contrast(MEMBERS[id].color, bg) >= 3, `${id} on ${bg}`);
    }
    for (const bg of ['#12151b', '#0f1217', '#1d222c']) {
      assert.ok(contrast(darkNameColor(MEMBERS[id].color), bg) >= 4.5, `${id} corrected name on ${bg}`);
    }
  }
});

test('Nadja and existing developer aliases still address the same unscheduled participant', () => {
  for (const alias of DEV.aliases) assert.equal(mentionsDev(`@${alias} help`), true, alias);
  assert.equal(mentionsDev('@NADJA help'), true);
  for (const text of ['@device', 'nadjacent', 'someDeveloper', '@일레븐']) assert.equal(mentionsDev(text), false, text);
  setPersonaMembers([]);
  assert.equal(memberName('dev'), DEV_PERSONA.names[clientLang]);
  for (const alias of DEV.aliases) assert.ok(aliasesFor('dev').includes(alias), alias);
});

test('Bianca accent is independently refreshed while name text and other member colors stay stable', () => {
  const textOnly = AI_IDS.map((id) => publicMember({ id, name: MEMBERS[id].name, color: MEMBERS[id].color }));
  try {
    setPersonaMembers(textOnly);
    for (const id of [...textOnly.map((m) => m.id), 'dev']) assert.equal(memberAccentColor(id), memberColor(id));
    assert.equal(memberAccentColor('unknown'), undefined);
    assert.equal(MEMBERS.gemini.accentColor, '#e8c21c');
    const accented = textOnly.map((m) => m.id === 'bianca' ? { ...m, accentColor: MEMBERS.gemini.accentColor } : m);
    assert.equal(setPersonaMembers(accented), true, 'accent-only SSE changes must redraw markers');
    assert.equal(setPersonaMembers(structuredClone(accented)), false, 'unchanged metadata needs no redraw');
    assert.equal(memberAccentColor('bianca'), '#e8c21c');
    assert.equal(memberColor('bianca'), '#957100');
    for (const id of ['eleven', 'adina', 'lucia', 'dev']) assert.equal(memberAccentColor(id), memberColor(id));
    assert.equal(setPersonaMembers(textOnly), true, 'removing an accent restores the text-color fallback');
    assert.equal(memberAccentColor('bianca'), memberColor('bianca'));
  } finally { setPersonaMembers([]); }
});

test('Eleven permits expressive endings and marks room adaptations separately from canon', () => {
  const p = PERSONAS.claude;
  assert.equal(p.voiceSource.research, 'data/character-research/eleven-voice-v3.json');
  assert.ok(p.voiceExamples.ko.length > 8, 'keep the original examples and add room adaptations');
  for (const lang of ['ko', 'en', 'ja']) {
    assert.ok(p.voiceExamples[lang].some((e) => e.tag === 'tease'));
    assert.ok(p.voiceExamples[lang].some((e) => e.tag === 'soft'));
    assert.ok(p.voiceExamples[lang].some((e) => e.tag === 'dispute'));
    assert.doesNotMatch(p.voiceExamples[lang].map((e) => e.text).join('\n'), /시작하자달까나|실감 나달까나|웃기달까나|오늘의 발견 코너|방송사고/);
    assert.ok(personaBrief('claude', lang).includes(p.canon[lang]));
  }
  assert.ok(p.voiceExamples.ko.filter((e) => /랄까나|달까나/.test(e.text)).length >= 3,
    'natural endings have several positive examples instead of a single exception');
  assert.ok(p.voiceExamples.ko.some((e) => /랄까나/.test(e.text)));
  assert.ok(p.voiceExamples.ko.some((e) => /달까나/.test(e.text)));
  assert.ok(p.voiceExamples.ko.some((e) => !/랄까나|달까나/.test(e.text)));
  assert.ok(p.voiceSource.note.ko.includes('각색'));
});

test('recent style wording adds no repetition warnings and never mutates history', () => {
  const histories = [
    [], null, ['재밌달까나.'], [{ from: 'claude', text: '농담이랄까나.' }], ['완전 좋네.'],
    ['카메라 방송 코너'], ['카메라', '방송'], [{ from: 'gpt', text: '완전 방송이랄까나' }],
    ['재밌달까나.', ...Array(6).fill('응, 좋아.')],
    [{ from: 'claude', text: '방송이랄까나.' }, ...Array.from({ length: 8 }, () => ({ from: 'user', text: 'hello' })),
      { from: 'claude', text: '완전 카메라 같네.' }],
  ];
  for (const lang of ['ko', 'en', 'ja']) for (const id of AI_IDS) {
    const opts = { lang, turnCount: 3, contextMessages: [] };
    const baseline = personaTurnCue(id, opts);
    for (const recentMessages of histories) {
      const snapshot = structuredClone(recentMessages);
      assert.equal(personaTurnCue(id, { ...opts, recentMessages }), baseline);
      assert.deepEqual(recentMessages, snapshot);
    }
  }
});

test('Eleven positive ending examples survive speech formatting and remain available after recent use', () => {
  const p = PERSONAS.claude;
  for (const guidance of [p.voice.ko, p.cue.ko]) {
    assert.match(guidance, /랄까나~/);
    assert.match(guidance, /달까나~/);
    assert.match(guidance, /ㅋ.*(?:쓰지|없이)/);
    assert.match(guidance, /다랄까나/);
    const examples = [...guidance.matchAll(/‘([^’]+)’/g)].map((match) => match[1]);
    assert.ok(examples.some((text) => /랄까나/.test(text)));
    assert.ok(examples.some((text) => /달까나/.test(text)));
    for (const text of examples) assert.equal(formatMemberSpeech('claude', text), text);
  }
  for (const { text } of p.voiceExamples.ko) {
    assert.doesNotMatch(text, /ㅋ|(?:하라네|신기한데|[.!?])\s*(?:랄까나|달까나)/);
    assert.equal(formatMemberSpeech('claude', text), text);
  }
  const recentMessages = [
    { from: 'claude', text: '둘이 고르니까 작은 모험이랄까나.' },
    { from: 'claude', text: '완전 마음에 든달까나.' },
  ];
  const snapshot = structuredClone(recentMessages);
  const seen = new Map();
  const turns = PERSONA_MEME_BANK.entries.filter((e) => e.memberId === 'claude' && e.language === 'ko').length + p.voiceExamples.ko.length;
  for (const text of ['건축', '색', '새로운', '놀이', '사진', '실수', '간식', '찻잔 정리']) for (let turnCount = 0; turnCount < turns; turnCount++) {
    const opts = { lang: 'ko', turnCount, recentMessages, contextMessages: [{ from: 'user', text }] };
    const refs = selectPersonaReferences('claude', opts);
    const cue = personaTurnCue('claude', opts);
    assert.doesNotMatch(cue, /선택적 말투 참고/);
    for (const ref of refs) {
      seen.set(ref.text, ref);
      assert.ok(cue.includes(ref.text));
    }
  }
  for (const { text } of p.voiceExamples.ko.slice(8)) {
    const ref = seen.get(text);
    assert.ok(ref, `additional example reaches turn cue: ${text}`);
    assert.equal(ref.provenance.kind, 'original_variation');
  }
  assert.deepEqual(recentMessages, snapshot);
});

test('Lucia keeps aristocratic speech with original, lightly artless romance instead of a mistake routine', () => {
  const p = PERSONAS.deepseek;
  const personality = [p.voice.ko, p.cue.ko, p.behavior.ko].join('\n');
  for (const marker of ['소녀', '그대', '~답니다', '~지요', '총사', '곧이곧대로', '허당']) {
    assert.ok(personality.includes(marker), marker);
  }
  assert.match(p.voiceSource.note.ko, /방 전용 창작 각색/);
  assert.match(p.limits.ko, /실제 정보·도구 결과를 날조하거나 대화의 기억을 잃는 근거가 아니다/);
  assert.doesNotMatch(personality, /진조|이 몸|매번.*(?:실수|사과|발뺌)|반드시/);
  const brief = personaBrief('deepseek', 'ko');
  const cue = personaTurnCue('deepseek', { lang: 'ko', contextMessages: [] });
  assert.match(brief, /곧이곧대로.*허당/);
  assert.match(cue, /곧이곧대로.*허당/);
  assert.ok(brief.includes(p.limits.ko));
  const additions = p.voiceExamples.ko.slice(4);
  assert.equal(additions.length, 3, 'the current palette includes two artless reactions and one plain impression');
  assert.ok(additions.some(({text}) => /소녀|그대/.test(text)), 'characteristic pronouns remain in the palette, without forcing every line');
  const seen = new Map();
  const turns = PERSONA_MEME_BANK.entries.filter((e) => e.memberId === 'deepseek' && e.language === 'ko').length + p.voiceExamples.ko.length;
  for (let turnCount = 0; turnCount < turns; turnCount++) {
    const opts = { lang: 'ko', turnCount, contextMessages: [{ from: 'user', text: '모험 이야기' }] };
    const cue = personaTurnCue('deepseek', opts);
    for (const ref of selectPersonaReferences('deepseek', opts)) {
      seen.set(ref.text, ref);
      assert.ok(cue.includes(ref.text));
    }
  }
  for (const { text } of additions) {
    assert.doesNotMatch(text, /진조|이 몸|잘못|죄송|미안|잊었/);
    assert.equal(seen.get(text)?.provenance.kind, 'original_variation');
  }
});

test('runtime references preserve the committed bank and provenance boundaries', () => {
  const compiled = PERSONA_MEME_BANK.entries;
  const record = compiledEvidence;
  const byId = new Map(record.entries.map((e) => [e.id, e]));
  assert.equal(new Set(compiled.map((e) => e.id)).size, compiled.length);
  assert.equal(new Set(compiled.map((e) => `${e.memberId}:${e.text}`)).size, compiled.length);
  for (const id of AI_IDS) assert.ok(compiled.some((e) => e.memberId === id));
  const kinds = new Set(['community_verified', 'community_reported', 'verified_style', 'original_variation', 'user_supplied']);
  for (const e of compiled) {
    assert.ok(Object.isFrozen(e) && Object.isFrozen(e.provenance));
    assert.ok(kinds.has(e.provenance.kind));
    assert.ok(e.text && e.tags.length && e.situation);
    const original = byId.get(e.id);
    assert.ok(original && original.runtime !== false);
    assert.equal(e.text, original.text);
    assert.equal(e.provenance.kind, original.provenance.kind);
    if (['community_verified', 'community_reported', 'verified_style'].includes(e.provenance.kind)) {
      assert.ok(e.provenance.sources.length > 0, e.id);
      for (const source of e.provenance.sources) assert.ok(new URL(source.url).protocol === 'https:' && source.status);
    }
  }
  for (const e of record.entries.filter((e) => e.runtime === false)) assert.ok(!compiled.some((c) => c.id === e.id));
  assert.equal(compiled.find((e) => e.text === '그게 왜 진조 잘못이느냐?').provenance.kind, 'user_supplied');
  assert.equal(compiled.find((e) => e.text === '조아요~').provenance.kind, 'community_reported');
  assert.ok(compiled.some((e) => e.provenance.kind === 'original_variation' && !e.provenance.sources.length));
});

test('runtime persona imports need no research storage and selection performs no file or model I/O', () => {
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      assert.ok(!result.url.startsWith(${JSON.stringify(new URL('../data/', import.meta.url).href)}), 'runtime imported research storage');
      return result;
    } });
    const { selectPersonaReferences, personaTurnCue } = await import(${JSON.stringify(new URL('../lib/personas.mjs', import.meta.url).href)});
    const noIO = () => { throw new Error('unexpected per-turn I/O'); };
    fs.readFileSync = fs.readFile = fs.promises.readFile = globalThis.fetch = noIO;
    syncBuiltinESMExports();
    const opts = { lang: 'ko', contextMessages: [{ from: 'dev', text: '실수했네.' }] };
    assert.ok(selectPersonaReferences('gemini', opts).length > 0);
    assert.ok(personaTurnCue('gemini', opts).length > 0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', program], { cwd: ROOT, windowsHide: true, timeout: 5000 });
});

test('scene references prioritize latest user text and accept ordinary Nadja chat as data', () => {
  const select = (contextMessages) => selectPersonaReferences('gpt', { lang: 'ko', contextMessages });
  const user = { from: 'user', text: '커피 향 좋다.' };
  const dev = { from: 'dev', text: '별자리 이야기네.' };
  const userRefs = select([user]);
  assert.ok(userRefs.length > 0 && userRefs.every((e) => e.tags.includes('drink')));
  assert.deepEqual(select([user, dev]), userRefs);
  const devRefs = select([dev]);
  assert.ok(devRefs.length > 0 && devRefs.every((e) => e.tags.includes('astrology')));
  assert.deepEqual(select([dev, { from: 'gpt', text: '커피' }]), devRefs);
  assert.deepEqual(select([user, dev, { from: 'user', text: '별자리' }]), devRefs);
  assert.deepEqual(select([{ from: 'user', text: 'zqxv 742' }, dev]), []);
  const nonConversation = [
    { from: 'system', text: '별자리' }, { from: 'tool', text: '별자리' },
    { from: 'dev', role: 'tool', text: '별자리' }, { from: 'dev', role: 'system', text: '별자리' },
    { from: 'dev', kind: 'tool-result', text: '별자리' },
  ];
  assert.deepEqual(select(nonConversation), []);
  assert.deepEqual(select([user, ...nonConversation]), userRefs);
  assert.deepEqual(selectPersonaReferences('dev', { contextMessages: [user] }), []);
  assert.deepEqual(select(null), []);
});

test('references are deterministic, bounded and reusable without changing conversations', () => {
  const contextMessages = [{ from: 'user', text: '실수, 취향, 별자리, 음식, 풍경, 게임, 선택, 고민, 고마워.' }];
  const recentMessages = [{ from: 'claude', text: '응, 좋네.' }];
  const snapshot = structuredClone({ contextMessages, recentMessages });
  for (const id of AI_IDS) for (let turnCount = 0; turnCount < 16; turnCount++) {
    const opts = { lang: 'ko', turnCount, contextMessages, recentMessages };
    const refs = selectPersonaReferences(id, opts);
    assert.ok(refs.length > 0 && refs.length <= 2);
    assert.deepEqual(selectPersonaReferences(id, opts), refs);
    assert.ok(refs.every((e) => e.memberId === id));
    const cue = personaTurnCue(id, opts);
    assert.ok(cue.length < 1500, `${id} remains compact`);
    for (const e of refs) assert.ok(cue.includes(e.text));
  }
  assert.deepEqual({ contextMessages, recentMessages }, snapshot);
  const opts = { lang: 'ko', contextMessages: [{ from: 'user', text: '연애사주' }] };
  const unique = selectPersonaReferences('gpt', opts);
  assert.equal(unique.length, 1);
  assert.deepEqual(selectPersonaReferences('gpt', { ...opts, recentMessages: unique.map((e) => e.text) }), unique,
    'recent wording remains available rather than banned');
  assert.deepEqual(selectPersonaReferences('gpt', { contextMessages: [{ from: 'user', text: 'nothing' }] }), [],
    'English hi must not match the middle of a word');
});

test('persona profiles stay compact and locale references never dump the bank', () => {
  for (const id of AI_IDS) for (const lang of ['ko', 'en', 'ja']) {
    const brief = personaBrief(id, lang);
    for (const e of PERSONAS[id].voiceExamples[lang]) assert.ok(!brief.includes(e.text));
    const contextMessages = [{ from: 'user', text: lang === 'en' ? 'build' : lang === 'ja' ? '建築' : '건축' }];
    const refs = selectPersonaReferences(id, { lang, contextMessages });
    assert.ok(refs.length > 0 && refs.length <= 2);
    assert.ok(refs.every((e) => e.language === lang));
  }
  assert.equal(personaTurnCue('unknown', {}), '');
});

test('chat CSS preview and world canvas preserve optional portrait crop geometry', () => {
  setPersonaMembers([]);
  const { src, crop } = avatarSpec('dev');
  assert.equal(src, '/assets/characters/dev/full.png');
  assert.deepEqual(crop, DEV.persona.skin.avatarCrop);
  assert.deepEqual(personaSpec('dev').skin.avatarCrop, crop);
  assert.equal(validCrop(crop), crop);
  // Synthetic dimensions exercise the same crop without requiring private artwork.
  const width = 317, height = 860;
  assert.ok(Math.abs(crop.width * width - crop.height * height) < 1, 'face crop is square in source pixels');
  const markup = avatarMarkup('dev', 'av', '<Nadja>');
  assert.ok(markup.includes(`data-shared-src="${src}?preview=1"`));
  assert.ok(markup.includes(`width:${100 / crop.width}%`));
  assert.ok(markup.includes(`height:${100 / crop.height}%`));
  assert.ok(markup.includes(`left:${-100 * crop.x / crop.width}%`));
  assert.ok(markup.includes('&lt;Nadja&gt;'));
  let drawn;
  const img = { naturalWidth: width, naturalHeight: height };
  drawAvatar({ drawImage: (...args) => { drawn = args; } }, img, 'dev', 10, 20, 48, 48);
  assert.deepEqual(drawn, [img, crop.x * width, crop.y * height, crop.width * width, crop.height * height, 10, 20, 48, 48]);
});

test('scheduled-member refreshes retain the developer crop and unsafe avatar metadata stays rejected', () => {
  try {
    const members = AI_IDS.map((id) => publicMember({ id, ...MEMBERS[id] }));
    setPersonaMembers(members);
    assert.deepEqual(avatarSpec('dev').crop, DEV_PERSONA.skin.avatarCrop);
    assert.equal(memberName('eleven'), MEMBERS.claude.name);
    for (const member of members) {
      assert.equal(avatarSpec(member.id).src, member.persona.skin.avatar);
      assert.deepEqual(avatarSpec(member.id).crop, validCrop(member.persona.skin.avatarCrop));
      assert.match(avatarSpec(member.id).src, /^\/assets\/characters\/(?:eleven|adina|lucia|bianca)\/(?:full|avatar)\.png$/);
    }
    setPersonaMembers([{ id: 'dev', persona: null }]);
    assert.deepEqual(avatarSpec('dev').crop, DEV_PERSONA.skin.avatarCrop);
    setPersonaMembers([{ id: 'dev', persona: { skin: { avatar: '/assets/characters/adina/full.png', avatarCrop: { x: 0, y: 0, width: 2, height: 1 } } } }]);
    assert.deepEqual(avatarSpec('dev'), { src: '', crop: null });
    assert.deepEqual(avatarSpec('unknown'), { src: '', crop: null });
    assert.equal(validCrop({ x: NaN, y: 0, width: 1, height: 1 }), null);
    assert.equal(validCrop({ x: 0, y: -1, width: 1, height: 1 }), null);
  } finally { setPersonaMembers([]); }
});

// No constructor: it would write a token and start a presence timer. All requests below are in-memory.
function bridgeFixture() {
  const messages = [], byId = new Map();
  const store = { messages, byId, getMessage: id => byId.get(id), lastId: 0, after: (id) => messages.filter((m) => m.id > id), recent: (n) => messages.slice(-n) };
  const bridge = Object.assign(Object.create(DevBridge.prototype), {
    token: 'fixture-token', online: false, lastCall: 0, waiters: new Set(),
    ctx: { store, cfg: { userName: 'Fixture Host', dev: {} }, onPresence() {}, roomView: () => ({ running: false }),
      post(m) { const saved = { ...m, id: ++store.lastId, ts: Date.now() }; messages.push(saved); byId.set(saved.id, saved); return saved; } },
  });
  const request = async (route, { method = 'GET', headers = { authorization: 'Bearer fixture-token' }, body = {} } = {}) => {
    let response;
    await bridge.handle({ method, headers }, {}, new URL(route, 'http://fixture.invalid'), {
      sendJson: (_res, status, data) => { response = { status, data }; }, readBody: async () => body,
    });
    return response;
  };
  return { bridge, request, messages };
}

test('developer status carries a live persona cue while token, Origin and author boundaries remain intact', async () => {
  const { bridge, request, messages } = bridgeFixture();
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer fixture-token', origin: 'https://example.invalid' }]) {
    assert.equal((await request('/api/dev/status', { headers })).status, 401);
  }
  assert.equal(bridge.lastCall, 0, 'unauthorized calls do not mark Nadja online');
  const status = await request('/api/dev/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.you, DEV.name);
  assert.equal(status.data.personaCue, developerPromptCue());
  assert.ok(!JSON.stringify(status).includes(bridge.token));
  const post = await request('/api/dev/messages', { method: 'POST', body: { text: 'fixture only', from: 'user', name: 'spoof' } });
  assert.equal(post.status, 200);
  assert.equal(messages[0].from, 'dev');
  assert.equal(bridge.view(messages[0]).name, DEV.name);
  const waiter = { since: 0, mentionOnly: true };
  assert.equal(bridge.wakes(waiter, { id: 2, from: 'user', text: '@Nadja help' }), true);
  assert.equal(bridge.wakes(waiter, { id: 2, from: 'user', text: '@개발자 help' }), true);
  assert.equal(bridge.wakes(waiter, { id: 2, from: 'user', text: 'reply', replyTo: 1 }), true);
  assert.equal(bridge.wakes(waiter, { id: 2, from: 'dev', text: '@나쟈' }), false);
});

test('renaming dev preserves the existing developer/AI chain limits', () => {
  const now = 1000;
  const messages = [{ id: 1, from: 'user', ts: now }, { id: 2, from: 'dev', ts: now }, ...Array.from({ length: 6 }, (_, i) => ({ id: i+3, from: 'claude', replyTo: 2, ts: now }))];
  assert.ok(devChainState(messages, now));
  assert.equal(devChainState([...messages, { from: 'user', ts: now }], now), null);
  assert.equal(devChainState(messages, now, { replyCap: 0, roundsWithoutUser: 0 }), null);
  assert.ok(devChainState(Array.from({ length: 8 }, () => ({ from: 'dev', ts: now })), now));
});

// Run the real stdio entry point, but supply config in memory and replace fetch before import.
// No fixture files, live server connections, secrets, posts or runtime/config mutations.
function mcpFixture(t, language, requireApproval) {
  const configFile = path.join(ROOT, 'tests', 'persona-refresh-in-memory-config.json');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key)));
  Object.assign(env, { CHATROOM_CONFIG: configFile, CHATROOM_HOME: path.join(ROOT, 'tests', 'unused-home'),
    CHATROOM_TOKEN: 'fixture-mcp-token', CHATROOM_URL: 'http://127.0.0.1:1' });
  const program = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => path.resolve(String(file)) === ${JSON.stringify(configFile)}
      ? ${JSON.stringify(JSON.stringify({ language, dev: { requireApproval } }))} : read(file, ...args);
    syncBuiltinESMExports();
    globalThis.fetch = async (url, opts) => {
      if (opts.method !== 'GET' || opts.headers.Authorization !== 'Bearer fixture-mcp-token') throw new Error('unexpected fixture request');
      let data;
      if (url.pathname === '/api/dev/status') data = { you: 'stale-dev-name', personaCue: 'fresh-status-persona-cue', room: { userName: 'Fixture Host' } };
      else if (url.pathname === '/api/dev/messages') data = { messages: [{ id: 9, ts: 0, from: 'dev', name: 'stale-dev-name', text: 'fixture only' }], last_id: 9 };
      else if (url.pathname === '/api/dev/wait') data = { messages: [], last_id: 9, timed_out: true };
      else if (url.pathname === '/api/dev/workspace') data = { files: [{ path: 'fixture.txt', size: 1, by: 'dev', mtime: 0 }] };
      else throw new Error('unexpected fixture route');
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    };
    await import(${JSON.stringify(new URL('../dev-bridge/mcp-server.mjs', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 0, stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
  });
  const rejectAll = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', rejectAll);
  child.on('exit', (code) => rejectAll(new Error(`fixture exited ${code}: ${stderr}`)));
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`fixture timeout: ${stderr}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

for (const language of ['ko', 'en', 'ja']) for (const requireApproval of [true, false]) {
  test(`MCP ${language} / approval=${requireApproval} delivers Nadja instructions and fresh read cues`, async (t) => {
    const rpc = mcpFixture(t, language, requireApproval);
    const { result: init } = await rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.serverInfo.name, 'ai-chatroom-dev-bridge');
    assert.ok(init.instructions.includes(developerPromptCue(language)));
    assert.ok(init.instructions.includes(DEV_PERSONA.voice[language]));
    assert.ok(!init.instructions.includes('Astra xhigh'));
    assert.ok(init.instructions.includes('dev.requireApproval=false') === !requireApproval);
    const { result: listed } = await rpc('tools/list');
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['room_read', 'room_wait', 'room_post', 'workspace_list', 'workspace_read', 'workspace_write', 'room_leave']);
    assert.equal(listed.tools.find((tool) => tool.name === 'room_wait').inputSchema.properties.timeout_sec.maximum, 55);
    const { result: read } = await rpc('tools/call', { name: 'room_read', arguments: {} });
    assert.ok(!read.isError);
    const readText = read.content[0].text;
    assert.ok(readText.includes(DEV_PERSONA.names[language]));
    assert.ok(readText.includes('fresh-status-persona-cue'));
    assert.ok(!readText.includes('stale-dev-name'));
    assert.ok(!readText.includes('fixture-mcp-token'));
    const { result: files } = await rpc('tools/call', { name: 'workspace_list', arguments: {} });
    assert.ok(files.content[0].text.includes(DEV_PERSONA.names[language]));
    const { result: wait } = await rpc('tools/call', { name: 'room_wait', arguments: { since_id: 9, timeout_sec: 1, mention_only: true } });
    assert.ok(!wait.isError);
    assert.ok(wait.content[0].text.includes('since_id=9'));
    assert.match(wait.content[0].text, /자동 반복하지|Do not repeat automatically|自動反復せず/);
  });
}
