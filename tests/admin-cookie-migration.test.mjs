import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { serviceFixture } from './helpers/service-fixture.mjs';

const require = createRequire(import.meta.url);
let chromium;
for (const name of [process.env.CHATROOM_PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { ({ chromium } = require(name)); break; } catch {}
}
const executablePath = process.env.CHATROOM_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);

test('actual mounted login survives legacy root/subpath cookies without clearing browser data', { timeout: 30000, skip: !chromium }, async t => {
  const f = await serviceFixture(t, { messageCount: 2 });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const oldHeader = ['a', 'b'].map(value => 'ai_chatroom_admin=' + Buffer.alloc(32, value).toString('base64url')).join('; ');
    const wrong = await f.request('/chat/api/admin/login', { method: 'POST', origin: f.origin, cookie: oldHeader, body: { password: 'wrong-fixture-password' } });
    assert.equal(wrong.status, 401, 'legacy cookies must not bypass the password check');
    const context = await browser.newContext();
    const legacy = ['/', '/chat/'].map((cookiePath, index) => ({ name: 'ai_chatroom_admin', value: Buffer.alloc(32, index + 1).toString('base64url'), domain: new URL(f.origin).hostname, path: cookiePath, httpOnly: true, sameSite: 'Strict' }));
    await context.addCookies(legacy);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(f.origin + '/chat/admin');
    await page.waitForSelector('#loginDialog[open]');
    assert.equal(await page.locator('#power').isDisabled(), true);
    const login = async () => {
      await page.fill('#adminPassword', fs.readFileSync(path.join(f.data, 'admin-password.txt'), 'utf8').trim());
      const reply = page.waitForResponse(response => response.url().endsWith('/api/admin/login'));
      await page.click('#loginSubmit');
      assert.equal((await reply).status(), 200, 'correct password must work with both legacy cookies');
      await page.waitForFunction(() => document.body.dataset.role === 'admin' && !document.querySelector('#loginDialog').open);
    };
    await login();
    const scoped = (await context.cookies(f.origin + '/chat/')).filter(cookie => cookie.name !== 'ai_chatroom_admin');
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].path, '/chat/'); assert.equal(scoped[0].httpOnly, true); assert.equal(scoped[0].sameSite, 'Strict');
    const currentPair = scoped[0].name + '=' + scoped[0].value;
    assert.equal((await f.request('/chat/api/session', { cookie: currentPair + '; ' + currentPair })).json.role, 'viewer', 'duplicate current credentials still fail closed');
    await page.reload(); await page.waitForFunction(() => document.body.dataset.role === 'admin');
    assert.equal(await page.locator('#power').isDisabled(), false);
    const request = await context.request.get(f.origin + '/chat/api/session');
    assert.equal((await request.json()).role, 'admin');
    const oldOnly = legacy.map(cookie => cookie.name + '=' + cookie.value).join('; ');
    assert.equal((await f.request('/chat/api/session', { cookie: oldOnly })).json.role, 'viewer');
    await page.click('#adminLogout'); await page.waitForFunction(() => document.body.dataset.role === 'viewer');
    assert.equal((await f.request('/chat/api/session', { cookie: currentPair })).json.role, 'viewer');
    await page.click('#adminLogin'); await login();
    const state = await (await context.request.get(f.origin + '/chat/api/state')).json();
    assert.equal(state.room.running, false); assert.equal(state.room.sleeping, true);
    assert.deepEqual(errors, []);
    assert.deepEqual((await f.metrics()).violations, []);
  } finally { await browser.close(); }
});
