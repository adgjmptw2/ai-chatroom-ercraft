// Real Chromium, synthetic loopback HTTP only. Serves the unchanged topics UI
// and base-path helper; never imports the production server or writes room data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '../public');
const base = '/chat';
const require = createRequire(import.meta.url);
let chromium;
for (const name of [process.env.CHATROOM_PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { ({ chromium } = require(name)); break; } catch { /* next installed runtime */ }
}
const executablePath = process.env.CHATROOM_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const browserOptions = { timeout: 30000, skip: !chromium && 'Set CHATROOM_PLAYWRIGHT_MODULE to run browser checks' };
const sourceUrl = 'https://example.invalid/story?from=fixture&topic=1';
const publicItem = { id: 'exposed', version: 'e'.repeat(64), status: 'exposed', title: '함께 고르는 오늘의 간식',
  text: '바닷가 집에서 나눠 먹을 간식을 골라 봐요.\n따뜻한 차와 잘 어울리는 간식은 무엇일까요?', sourceUrl };
const pendingItem = { id: 'pending-approve', version: 'a'.repeat(64), status: 'pending', title: '검토 대기 중인 비공개 이야기', text: '공개 목록에서는 보이면 안 되는 합성 내용입니다.', sourceUrl };
const rejectedItem = { ...pendingItem, id: 'pending-reject', version: 'b'.repeat(64), title: '보류할 비공개 이야기', sourceUrl: '' };
const malicious = { ...publicItem, id: 'hostile', title: '<img src=x onerror="window.__topicXss=1">',
  text: '<script>window.__topicXss=2</script>\n<svg onload="window.__topicXss=3"></svg><iframe src="https://example.invalid/x"></iframe>' };
const formBody = { title: '새로 제보하는 합성 화제', text: '빗소리를 들으며 함께 쉬는 하루를 이야기해 보면 어떨까요?', sourceUrl, consent: true };

async function fixture(t, { admin = false, items = [publicItem, pendingItem, rejectedItem], viewport = { width: 1280, height: 1000 } } = {}) {
  const data = { enabled: true, items: structuredClone(items), submitReply: { accepted: true }, failRefresh: false };
  const requests = [], posts = [], blocked = [], errors = [], unexpected = [];
  const authenticated = (req) => req.headers.cookie?.includes('fixture=admin') === true;
  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, method: req.method, cookie: req.headers.cookie });
    if (!url.pathname.startsWith(base + '/')) { unexpected.push(url.pathname); return json(res, { error: 'outside fixture mount' }, 404); }
    const route = url.pathname.slice(base.length);
    if (req.method === 'GET' && route === '/api/session') return json(res, { role: authenticated(req) ? 'admin' : 'viewer', authenticated: authenticated(req) });
    if (req.method === 'GET' && route === '/api/topics') {
      if (data.failRefresh) return json(res, { error: '목록을 불러오지 못했습니다.' }, 503);
      return json(res, { enabled: data.enabled,
        items: data.items.filter((item) => item.status === 'exposed').map(({ title, text, sourceUrl }) => ({ title, text, sourceUrl })) });
    }
    if (req.method === 'GET' && route === '/api/admin/topics') {
      return authenticated(req) ? json(res, { items: data.items }) : json(res, { error: '관리자 로그인이 필요합니다.' }, 401);
    }
    if (req.method === 'POST' && ['/api/topics/submit', '/api/admin/topics'].includes(route)) {
      let input = ''; for await (const chunk of req) input += chunk;
      const body = JSON.parse(input);
      posts.push({ path: url.pathname, body });
      if (route === '/api/admin/topics' && !authenticated(req)) return json(res, { error: '관리자 로그인이 필요합니다.' }, 401);
      if (route === '/api/topics/submit' || body.action === 'submit') {
        if (!data.enabled) return json(res, { error: '이야기 제보를 잠시 쉬고 있습니다.' }, 503);
        if (body.consent !== true) return json(res, { error: '직접 작성한 내용의 AI 대화 활용·공개에 동의해 주세요.' }, 400);
        data.items.push({ ...body, id: `new-${posts.length}`, version: 'c'.repeat(64), status: 'pending', kind: route === '/api/topics/submit' ? 'visitor' : 'owner', mailStatus: data.submitReply.mailStatus });
        return json(res, data.submitReply, route === '/api/topics/submit' ? 202 : 200);
      }
      const item = data.items.find((item) => item.id === body.id);
      if (!item) return json(res, { error: '제보를 찾을 수 없습니다.' }, 404);
      if (item.version !== body.version) return json(res, { error: '내용이 달라졌습니다. 다시 확인해 주세요.' }, 409);
      if (item.status !== 'pending') return json(res, { error: '이미 검토된 제보입니다.' }, 409);
      if (!['approve', 'reject'].includes(body.action)) return json(res, { error: '검토 동작을 확인해 주세요.' }, 400);
      item.status = body.action === 'approve' ? 'approved' : 'rejected';
      return json(res, { ok: true });
    }
    if (route === '/favicon.ico' || route === '/ercraft-symbol.png') { res.writeHead(204); res.end(); return; }
    const file = { '/topics': 'topics.html', '/topics.js': 'topics.js', '/base-path.js': 'base-path.js' }[route];
    if (req.method !== 'GET' || !file) { unexpected.push(req.url); return json(res, { error: 'unexpected fixture request' }, 404); }
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('.html')) source = source.replace('<head>', `<head><meta name="chatroom-base" content="${base}">`)
      .replace(/\b(href|src|action)=(['"])\/(?!\/)/g, `$1=$2${base}/`);
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
    res.end(source);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    blocked.push(url); return route.abort();
  });
  if (admin) await context.addCookies([{ name: 'fixture', value: 'admin', domain: '127.0.0.1', path: base + '/', httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + base + '/topics');
  await page.waitForFunction(() => document.querySelector('#recent').textContent.trim().length > 0);
  if (admin) await page.waitForSelector('#review-list article');
  t.after(() => {
    assert.deepEqual(errors, [], 'no browser script errors');
    assert.deepEqual(blocked, [], 'no external requests, including source links and injected markup');
    assert.deepEqual(unexpected, [], 'all requests stay within the mounted fixture routes');
  });
  return { page, context, data, requests, posts };
}

async function fill(page, body = formBody, consent = true) {
  await page.getByLabel('제목', { exact: true }).fill(body.title);
  await page.getByLabel('직접 정리한 이야기', { exact: true }).fill(body.text);
  await page.getByLabel('출처 링크 (선택)', { exact: true }).fill(body.sourceUrl);
  if (consent) await page.locator('#consent').check();
}
async function submit(page, route = '/api/topics/submit') {
  const response = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith(base + route));
  await page.getByRole('button', { name: '검토 요청', exact: true }).click();
  return response;
}
async function snapshot(page, name, t) {
  if (!process.env.CHATROOM_TOPICS_SCREENSHOT_DIR) return;
  const directory = path.resolve(process.env.CHATROOM_TOPICS_SCREENSHOT_DIR);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name + '.png');
  await page.screenshot({ path: file, fullPage: true });
  t.diagnostic(`Screenshot: ${file}`);
}

test('viewer consent gates submission; mounted requests and pending privacy remain intact', browserOptions, async (t) => {
  const f = await fixture(t), p = f.page;
  assert.equal(await p.locator('meta[name="chatroom-base"]').getAttribute('content'), base);
  assert.equal(await p.locator('script[type="module"]').getAttribute('src'), base + '/topics.js');
  assert.equal(await p.locator('link[rel="icon"]').getAttribute('href'), base + '/ercraft-symbol.png');
  assert.equal(await p.getByRole('link', { name: '단톡방으로' }).getAttribute('href'), base + '/');
  assert.equal(await p.getByRole('link', { name: '물결마루' }).getAttribute('href'), base + '/world.html');
  assert.equal(await p.locator('#admin').isVisible(), false);
  assert.equal(await p.locator('#review-list').textContent(), '');
  assert.equal(f.requests.some((r) => r.path === base + '/api/admin/topics'), false);
  assert.equal(await p.locator('#recent article').count(), 1);
  assert.ok(!(await p.locator('body').innerText()).includes(pendingItem.title));
  await fill(p, formBody, false);
  await p.getByRole('button', { name: '검토 요청', exact: true }).click();
  assert.equal(await p.locator('#consent').evaluate((node) => node.validity.valueMissing), true);
  assert.equal(f.posts.length, 0, 'native required-consent validation prevents the POST');
  await p.locator('#consent').check();
  const response = await submit(p);
  assert.equal(response.status(), 202);
  await p.waitForFunction(() => document.querySelector('#notice').textContent.includes('접수했습니다'));
  assert.deepEqual(f.posts, [{ path: base + '/api/topics/submit', body: formBody }]);
  assert.equal(f.data.items.at(-1).status, 'pending');
  assert.equal(await p.locator('#title').inputValue(), '');
  assert.equal(await p.locator('#consent').isChecked(), false);
  assert.equal(await p.locator('#recent article').count(), 1);
  assert.ok(!(await p.locator('body').innerText()).includes(formBody.title));
  assert.ok(f.requests.some((r) => r.path === base + '/api/session'));
  assert.ok(f.requests.some((r) => r.path === base + '/base-path.js'));
  assert.equal(await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), '{}');
});

test('public and admin cards render hostile title/body as literal text; external sources retain safe rel', browserOptions, async (t) => {
  const hostilePending = { ...malicious, id: 'hostile-pending', status: 'pending', version: 'd'.repeat(64) };
  const f = await fixture(t, { admin: true, items: [malicious, hostilePending] }), p = f.page;
  for (const selector of ['#recent article', '#review-list article']) {
    for (const card of await p.locator(selector).all()) {
      assert.equal(await card.locator('h2').textContent(), malicious.title);
      assert.equal(await card.locator('p').first().textContent(), malicious.text);
      assert.equal(await card.locator('script, img, svg, iframe').count(), 0);
      const link = card.getByRole('link', { name: '출처 보기' });
      assert.equal(await link.getAttribute('href'), sourceUrl);
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.deepEqual((await link.getAttribute('rel')).split(/\s+/).sort(), ['nofollow', 'noopener', 'noreferrer']);
    }
  }
  assert.equal(await p.evaluate(() => window.__topicXss), undefined);
  assert.equal(await p.locator('#recent article').count(), 1, 'pending content only appears in the admin queue');
});

test('admin approval and rejection submit the exact displayed id/version without exposing pending topics', browserOptions, async (t) => {
  const f = await fixture(t, { admin: true }), p = f.page;
  for (const [item, action, label, status] of [[pendingItem, 'approve', '승인', 'approved'], [rejectedItem, 'reject', '보류', 'rejected']]) {
    const card = p.locator('#review-list article').filter({ has: p.getByRole('heading', { name: item.title, exact: true }) });
    const response = p.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith(base + '/api/admin/topics'));
    await card.getByRole('button', { name: label, exact: true }).click();
    assert.equal((await response).status(), 200);
    await p.waitForFunction(({ title }) => [...document.querySelectorAll('#review-list article')].find((node) => node.querySelector('h2').textContent === title)?.querySelectorAll('button').length === 0, { title: item.title });
    assert.deepEqual(f.posts.at(-1), { path: base + '/api/admin/topics', body: { id: item.id, version: item.version, action } });
    assert.equal(f.data.items.find((row) => row.id === item.id).status, status);
    assert.ok(!(await p.locator('#recent').textContent()).includes(item.title));
  }
  assert.ok(f.requests.filter((r) => r.path === base + '/api/admin/topics').every((r) => r.cookie?.includes('fixture=admin')));
  assert.equal(await p.evaluate(() => document.cookie), '');
  await snapshot(p, 'topics-admin-desktop', t);
});

test('a stale review version reports conflict and does not silently approve newer content', browserOptions, async (t) => {
  const f = await fixture(t, { admin: true }), p = f.page;
  const item = f.data.items.find((row) => row.id === pendingItem.id);
  item.version = 'f'.repeat(64); item.text = '다시 검토해야 하는 바뀐 합성 내용';
  const card = p.locator('#review-list article').filter({ has: p.getByRole('heading', { name: pendingItem.title, exact: true }) });
  const response = p.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith(base + '/api/admin/topics'));
  await card.getByRole('button', { name: '승인', exact: true }).click();
  assert.equal((await response).status(), 409);
  await p.waitForFunction(() => document.querySelector('#notice').textContent.includes('내용이 달라졌습니다'));
  assert.equal(item.status, 'pending');
  assert.equal(f.posts.at(-1).body.version, pendingItem.version);
  assert.equal(await card.getByRole('button', { name: '승인', exact: true }).isEnabled(), true);
  await p.getByRole('button', { name: '목록 새로고침' }).click();
  await p.waitForFunction((text) => document.querySelector('#review-list').textContent.includes(text), item.text);
  const retry = p.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith(base + '/api/admin/topics'));
  await card.getByRole('button', { name: '승인', exact: true }).click();
  assert.equal((await retry).status(), 200);
  assert.equal(f.posts.at(-1).body.version, item.version);
  assert.equal(item.status, 'approved');
});

test('admin owner mode uses the mounted private submit endpoint and still requires consent', browserOptions, async (t) => {
  const f = await fixture(t, { admin: true }), p = f.page;
  await p.locator('#as-owner').check();
  await fill(p, formBody, false);
  await p.getByRole('button', { name: '검토 요청', exact: true }).click();
  assert.equal(f.posts.length, 0);
  await p.locator('#consent').check();
  assert.equal((await submit(p, '/api/admin/topics')).status(), 200);
  await p.waitForFunction((title) => document.querySelector('#review-list').textContent.includes(title), formBody.title);
  assert.deepEqual(f.posts.at(-1), { path: base + '/api/admin/topics', body: { ...formBody, action: 'submit', kind: 'owner' } });
  assert.equal(f.data.items.at(-1).kind, 'owner');
  assert.equal(f.data.items.at(-1).status, 'pending');
  assert.ok(!(await p.locator('#recent').textContent()).includes(formBody.title));
  await p.locator('#as-owner').uncheck();
  await fill(p, { ...formBody, title: '일반 제보 경로도 유지' });
  assert.equal((await submit(p)).status(), 202);
  assert.deepEqual(f.posts.at(-1), { path: base + '/api/topics/submit', body: { ...formBody, title: '일반 제보 경로도 유지' } });
});

test('desktop and mobile topic forms remain readable and within the viewport', browserOptions, async (t) => {
  const { page: p } = await fixture(t);
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await p.setViewportSize(viewport);
    const metrics = await p.evaluate(() => {
      const nodes = [...document.querySelectorAll('nav, h1, #submit-form, #submit-form input, textarea, #submit-button, #recent article')];
      return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        bounds: nodes.map((node) => { const r = node.getBoundingClientRect(); return { tag: node.id || node.tagName, left: r.left, right: r.right, width: r.width }; }),
        bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
        fieldFont: parseFloat(getComputedStyle(document.querySelector('#text')).fontSize),
        submitLabel: document.querySelector('#submit-button').textContent,
      };
    });
    assert.ok(metrics.scrollWidth <= metrics.width, name + ': no horizontal overflow');
    for (const bound of metrics.bounds) assert.ok(bound.width > 0 && bound.left >= 0 && bound.right <= metrics.width, `${name}: ${JSON.stringify(bound)}`);
    assert.ok(metrics.bodyFont >= 16 && metrics.fieldFont >= 16, name + ': readable base/control type');
    assert.equal(metrics.submitLabel, '검토 요청');
    assert.equal(await p.locator('#notice').getAttribute('role'), 'status');
    assert.equal(await p.locator('#notice').getAttribute('aria-live'), 'polite');
    await snapshot(p, 'topics-viewer-' + name, t);
  }
});

test('email notices distinguish acknowledged, failed, uncertain and saved-only submissions', browserOptions, async t => {
  const { page, data } = await fixture(t);
  for (const [mailStatus, expected] of [
    [undefined, '검토함에 저장되었습니다.'],
    ['saved', '검토함에 저장되었습니다.'],
    ['sent', '관리자에게 이메일 알림을 요청했습니다.'],
    ['failed', '이메일 알림 전송을 확인하지 못했지만, 제보는 검토함에 저장되었습니다.'],
    ['pending', '제보는 저장되었습니다. 이메일 알림 결과는 아직 확인되지 않았습니다.'],
    ['unknown', '검토함에 저장되었습니다.'],
  ]) {
    data.submitReply = { accepted: true, ...(mailStatus ? { mailStatus } : {}) };
    await fill(page);
    await submit(page);
    await page.waitForFunction(text => document.querySelector('#notice').textContent.includes(text), expected);
    const notice = await page.locator('#notice').textContent();
    assert.ok(notice.includes('관리자 검토 후'));
    if (mailStatus !== 'sent') assert.ok(!notice.includes('관리자에게 이메일 알림을 요청했습니다'));
    assert.doesNotMatch(notice, /전송 서비스|중단된 요청|재전송/);
    if (!mailStatus || ['saved', 'unknown'].includes(mailStatus)) assert.doesNotMatch(notice, /이메일/);
    assert.equal(await page.locator('#title').inputValue(), '');
    assert.ok(!(await page.locator('#recent').textContent()).includes(formBody.title));
  }
  data.submitReply = { accepted: true, duplicate: true, mailStatus: 'failed' };
  await fill(page); await submit(page);
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('이미 접수된 제보입니다.'));
  assert.match(await page.locator('#notice').textContent(), /제보는 검토함에 저장되었습니다/);
});

test('mail status stays separate from approval and does not expose pending content', browserOptions, async t => {
  const { page } = await fixture(t, { admin: true, items: [
    { ...publicItem, mailStatus: 'sent' }, { ...pendingItem, mailStatus: 'failed' }, { ...rejectedItem, mailStatus: 'pending' },
  ] });
  const queue = await page.locator('#review-list').textContent();
  assert.match(queue, /이메일 알림: 전송 서비스 접수 확인/);
  assert.match(queue, /이메일 알림: 전송 확인 실패/);
  assert.match(queue, /이메일 알림: 결과 미확인/);
  assert.equal(await page.locator('#review-list').getByRole('button', { name: '승인', exact: true }).count(), 2);
  assert.doesNotMatch(await page.locator('#recent').textContent(), /이메일 알림|비공개/);
});

test('a refresh failure preserves the saved/mail result instead of implying submission failed', browserOptions, async t => {
  const { page, data } = await fixture(t);
  data.submitReply = { accepted: true, mailStatus: 'failed' };
  data.failRefresh = true;
  await fill(page); await submit(page);
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('목록을 새로 불러오지 못했습니다.'));
  const notice = await page.locator('#notice').textContent();
  assert.match(notice, /제보를 접수했습니다/);
  assert.match(notice, /제보는 검토함에 저장되었습니다/);
  assert.equal(await page.locator('#title').inputValue(), '');
});

test('submitting and disabled intake keep the submit button locked', browserOptions, async t => {
  const { page, data, posts } = await fixture(t);
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  await page.route('**/api/topics/submit', async route => { started(); await blocked; await route.continue(); });
  await fill(page);
  await page.getByRole('button', { name: '검토 요청', exact: true }).click();
  await waiting;
  assert.equal(await page.locator('#submit-button').isDisabled(), true);
  await page.locator('#submit-form').dispatchEvent('submit');
  data.enabled = false;
  release();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('잠시 쉬고'));
  const refreshed = page.waitForResponse(res => res.url().endsWith(base + '/api/topics'));
  await page.evaluate(() => document.querySelector('#reload').click());
  await refreshed;
  await page.waitForFunction(() => document.querySelector('#submit-button').disabled);
  assert.equal(await page.locator('#submit-button').isDisabled(), true);
  assert.equal(posts.length, 1);
});
