import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setPersonaMembers, avatarSpec, avatarMarkup, memberName, aliasesFor } from '../public/persona-client.js';
import { quotaNote, sleepView, systemText } from '../public/presentation.js';

const providerNames = /claude|chatgpt|\bgpt\b|gpt-\d|grok|gemini|deepseek|anthropic|openai|\b(?:xai|hive|qwen|opus|sonnet|haiku|astra|codex)\b|클로드|그록|제미나이|딥시크|チャットGPT|クロード|ジェミニ/i;

test('served client code and styles contain only public character identities', () => {
  for (const file of ['app.js', 'base-path.js', 'persona-client.js', 'presentation.js', 'world.html', 'style.css', 'i18n.js', 'world-materials.js', 'world-home.js', 'world-diorama.js', 'index.html']) {
    const source = fs.readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, providerNames, file);
    assert.doesNotMatch(source, /legacyAliases|imageVision|imageGen|\/avatars\//, file);
  }
});

test('sleep presentation whitelists activity states and never reads quota metadata', () => {
  const tr = (key) => key;
  for (const state of ['awake', 'resting', 'asleep', 'unknown']) {
    const condition = { state };
    for (const key of ['level', 'remainingPct', 'resetAt', 'model']) {
      Object.defineProperty(condition, key, { get() { throw new Error('private metadata read'); } });
    }
    assert.deepEqual(sleepView(condition, tr), { state, label: `sleep.${state}` });
  }
  for (const state of ['ready', 'stale', 'error', 'drowsy', 'needsSleep', 'constructor', '<img>', '', null, {}, 0]) {
    for (let level = 0; level <= 4; level++) {
      assert.deepEqual(sleepView({ state, level, remainingPct: 87.65 }, tr), { state: 'unknown', label: 'sleep.unknown' });
    }
  }
  for (const condition of [null, undefined, {}, 4, 'awake', { level: 4 }]) {
    assert.deepEqual(sleepView(condition, tr), { state: 'unknown', label: 'sleep.unknown' });
  }
});

test('public client has no legacy battery storage/event and redacts only system metadata', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /batter(?:y|ies)|needsSleep|drowsy/i);
  const tr = (key, args) => `${key}:${args.name}`;
  const message = { from: 'system', by: 'eleven', kind: 'deep', text: '🔥 일레븐 진심모드 — private-model · private reason' };
  assert.equal(systemText(message, '일레븐', tr), 'boost.notice:일레븐');
  assert.equal(systemText({ ...message, from: 'eleven' }, '일레븐', tr), message.text);
});

test('portraits accept only public character asset routes and preserve face crops', () => {
  try {
    const crop = { x: 0.25, y: 0.1, width: 0.5, height: 0.5 };
    for (const id of ['eleven', 'adina', 'lucia', 'bianca']) {
      for (const kind of ['avatar', 'full']) {
        const src = `/assets/characters/${id}/${kind}.png`;
        setPersonaMembers([{ id, name: id, aliases: [id], persona: { skin: { avatar: src, avatarCrop: crop } } }]);
        assert.deepEqual(avatarSpec(id), { src, crop });
        assert.ok(avatarMarkup(id).includes(`data-shared-src="${src}?preview=1"`));
        assert.ok(avatarMarkup(id).includes('width:200%;height:200%;left:-50%;top:-20%;object-fit:fill'));
        assert.deepEqual(aliasesFor(id), [id]);
      }
    }
    for (const src of ['/avatars/grok-128.webp', '/assets/characters/claude/avatar.png', '/assets/characters/adina/avatar.png',
      '/assets/characters/eleven/../avatar.png', '/assets/characters/eleven/private.png', 'https://example.invalid/avatar.png']) {
      setPersonaMembers([{ id: 'eleven', persona: { skin: { avatar: src } } }]);
      assert.equal(avatarSpec('eleven').src, '');
      assert.doesNotMatch(avatarMarkup('eleven'), /<img/);
    }
  } finally { setPersonaMembers([]); }
});

test('avatar initials use only escaped public names, including when art or metadata is missing', () => {
  try {
    for (const [id, name] of Object.entries({ eleven: '일레븐', adina: '아디나', lucia: '루치아', bianca: '비앙카' })) {
      setPersonaMembers([{ id, name, color: '#258552', aliases: ['PRIVATE_ALIAS'] }]);
      const markup = avatarMarkup(id, '', name);
      assert.ok(markup.includes(`class="persona-avatar-initial" aria-hidden="true">${name[0]}</span>`));
      assert.ok(markup.includes(`role="img" aria-label="${name}"`));
      assert.ok(markup.includes('--avatar-color:#258552'));
      assert.doesNotMatch(markup, /<img|PRIVATE_ALIAS/);
    }
    setPersonaMembers([{ id: 'eleven', name: '  <공개 이름>', color: 'red;background:url(https://unsafe.invalid)' }]);
    assert.ok(avatarMarkup('eleven').includes('aria-hidden="true">&lt;</span>'));
    assert.doesNotMatch(avatarMarkup('eleven'), /unsafe\.invalid|background:url/);
    setPersonaMembers([{ id: 'PRIVATE_ROUTING_KEY', aliases: ['PRIVATE_ALIAS'], persona: { name: 'PRIVATE_PERSONA' } }]);
    const unknown = avatarMarkup('PRIVATE_ROUTING_KEY');
    assert.ok(unknown.includes('aria-hidden="true">?</span>'));
    assert.doesNotMatch(unknown, /PRIVATE_ROUTING_KEY|PRIVATE_ALIAS|PRIVATE_PERSONA/);
    assert.ok(avatarMarkup('dev').includes(`aria-hidden="true">${Array.from(memberName('dev'))[0]}</span>`));
  } finally { setPersonaMembers([]); }
});

test('former-member fallback has a neutral label without a legacy logo or alias', () => {
  setPersonaMembers([]);
  assert.notEqual(memberName('former-member'), 'former-member');
  assert.doesNotMatch(memberName('former-member'), providerNames);
  assert.deepEqual(avatarSpec('former-member'), { src: '', crop: null });
  assert.doesNotMatch(avatarMarkup('former-member'), /<img|\/avatars\//);
  assert.ok(avatarMarkup('former-member').includes(`aria-hidden="true">${Array.from(memberName('former-member'))[0]}</span>`));
  assert.deepEqual(aliasesFor('former-member'), [memberName('former-member')]);
});

test('unrecognized quota notes use common copy without provider-specific branches', () => {
  const tr = (key) => key;
  for (const note of ['Hive 별도 토큰 과금 · 잔액 미조회 · 이 방 호출 토큰은 data/hive-usage.jsonl에 기록', 'OpenAI private account', 'unrecognized note']) {
    assert.equal(quotaNote(note, tr), 'usage.details');
  }
  assert.equal(quotaNote('Limit reached', tr), 'Limit reached');
  assert.equal(quotaNote('', tr), '');
});
