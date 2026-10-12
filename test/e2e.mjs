// End-to-end check in a throwaway Chromium profile, with its own tokens and ports:
// extension -> relay -> MCP server -> Playwright, plus the relay's rejection rules.
// A second relay is reached over wss:// through a stand-in for `tailscale serve`.
// Needs a Chromium that still accepts --load-extension (branded Chrome does not):
//   BROWSER_RELAY_TEST_CHROMIUM=/path/to/Chromium npm test
// Defaults to the newest Playwright-cached Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import { checkRelays, fakeTailscaleServe } from './relays.mjs';
import { checkSessions } from './sessions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 19989;
const home = mkdtempSync(join(tmpdir(), 'browser-relay-test-'));
const env = { ...process.env, BROWSER_RELAY_HOME: home, BROWSER_RELAY_PORT: String(PORT) };
// config.mjs reads the environment when it is first imported, so set it before importing.
Object.assign(process.env, env);
const token = (await import('../src/config.mjs')).loadToken();

// Relay B stands for a relay on another machine: its own home, token and port,
// reached by the extension at wss://relay-b.test through a fake `tailscale serve`.
const PORT_B = 19990;
const homeB = mkdtempSync(join(tmpdir(), 'browser-relay-test-b-'));
const tokenB = randomBytes(32).toString('hex');
writeFileSync(join(homeB, 'token'), `${tokenB}\n`, { mode: 0o600 });
const serve = await fakeTailscaleServe(PORT_B, 'alice@example.com');
const publicHostB = `relay-b.test:${serve.port}`;
const envB = {
  ...process.env, BROWSER_RELAY_HOME: homeB, BROWSER_RELAY_PORT: String(PORT_B),
  BROWSER_RELAY_PUBLIC_HOSTS: publicHostB, BROWSER_RELAY_TAILSCALE_LOGINS: 'Alice@example.com',
};

function findChromium() {
  if (process.env.BROWSER_RELAY_TEST_CHROMIUM) return process.env.BROWSER_RELAY_TEST_CHROMIUM;
  if (process.platform === 'linux') {
    const cache = join(homedir(), '.cache', 'ms-playwright');
    const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
    return ['chrome-linux64', 'chrome-linux'].map((d) => join(cache, dir, d, 'chrome')).find(existsSync);
  }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  const base = ['chrome-mac-arm64', 'chrome-mac'].map((d) => join(cache, dir, d)).find(existsSync);
  const bundle = readdirSync(base).find((f) => f.endsWith('.app'));
  return join(base, bundle, 'Contents', 'MacOS', bundle.replace(/\.app$/, ''));
}

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>${req.url.slice(1) || 'home'}</title><h1>${req.url}</h1>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = (path) => `http://127.0.0.1:${site.address().port}/${path}`;

const relay = spawn(process.execPath, [join(ROOT, 'bin/browser-relay'), 'serve'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
const spawnRelayB = () => spawn(process.execPath, [join(ROOT, 'bin/browser-relay'), 'serve'], { env: envB, stdio: ['ignore', 'inherit', 'inherit'] });
const relayB = { process: spawnRelayB() };
const cleanup = [];
cleanup.push(() => relay.kill(), () => relayB.process.kill(), () => site.close(), () => serve.close());
cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(homeB, { recursive: true, force: true }));

async function upgradeStatus(path, headers, port = PORT) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on('open', () => (ws.close(), resolve(101)));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
}

try {
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null))?.status === 401, 'relay up');

  // 1. Relay rejection rules.
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/health`)).status, 401, 'health needs the token');
  assert.equal(await upgradeStatus('/cdp', { authorization: 'Bearer wrong' }), 401, 'cdp rejects a wrong token');
  assert.equal(await upgradeStatus('/cdp', { authorization: `Bearer ${token}`, origin: 'https://evil.example' }), 403, 'cdp rejects web origins');
  assert.equal(await upgradeStatus(`/extension?token=${token}`, { origin: 'https://evil.example' }), 403, 'extension path rejects web origins');
  assert.equal(await upgradeStatus(`/extension?token=wrong`, { origin: 'chrome-extension://abc' }), 401, 'extension path rejects a wrong token');
  assert.equal(await upgradeStatus('/cdp', { authorization: `Bearer ${token}`, host: 'evil.example' }), 403, 'cdp rejects foreign Host (DNS rebinding)');
  console.log('ok  relay rejects bad token, web origins and foreign hosts');

  await waitUntil(async () => (await relayRequest(PORT_B, '/health', { authorization: `Bearer ${tokenB}` })).status === 200, 'relay B up');
  await checkPublicHostRules();

  // 2. Throwaway browser with the extension, configured through its service worker.
  const profile = mkdtempSync(join(tmpdir(), 'browser-relay-profile-'));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  const ext = join(ROOT, 'extension');
  const testBrowser = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(),
    headless: true,
    args: [
      `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      // relay-b.test is the fake tailnet name; its certificate is self-signed.
      '--host-resolver-rules=MAP relay-b.test 127.0.0.1', '--ignore-certificate-errors',
    ],
  });
  cleanup.unshift(() => testBrowser.close());
  let sw = testBrowser.serviceWorkers()[0] ?? (await testBrowser.waitForEvent('serviceworker'));
  // Version 0.2 settings, as an upgraded extension would find them.
  await sw.evaluate(({ token, port }) => chrome.storage.local.set({ token, port }), { token, port: PORT });
  await waitUntil(async () => (await health()).extension, 'extension connected');
  const migrated = await sw.evaluate(() => chrome.storage.local.get(null));
  assert.deepEqual(migrated, { relays: [{ id: 'local', name: 'This computer', url: `ws://127.0.0.1:${PORT}`, token }] });
  console.log('ok  extension migrates 0.2 settings to a "This computer" relay and connects');

  // A restart can race with the startup alarm or a settings change. Only one
  // replacement socket should be opened, or the older socket can kill the new
  // socket's keepalive timer when the relay replaces it.
  const connectionAttempts = await sw.evaluate(async () => {
    const OriginalWebSocket = WebSocket;
    let attempts = 0;
    globalThis.WebSocket = class extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        attempts++;
      }
    };
    try {
      conns.get('local').ws.close();
      await Promise.all([connect('local'), connect('local')]);
      return attempts;
    } finally {
      globalThis.WebSocket = OriginalWebSocket;
    }
  });
  assert.equal(connectionAttempts, 1, 'simultaneous reconnects should open one socket');
  await waitUntil(async () => (await health()).extension, 'extension reconnected');
  console.log('ok  simultaneous reconnects open one socket');

  const userTab = testBrowser.pages()[0] ?? (await testBrowser.newPage());
  await userTab.goto(siteUrl('attached-by-user'));
  const userTabId = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: 'Research', color: 'blue' });
    await toggle(tab.id);
    return tab.id;
  });
  await waitUntil(async () => (await health()).tabs === 1, 'tab attached');
  const marker = async (tabId) => sw.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    const group = tab.groupId === -1 ? null : await chrome.tabGroups.get(tab.groupId);
    return { groupId: tab.groupId, title: group?.title, color: group?.color, pinned: tab.pinned };
  }, tabId);
  const userMarker = await marker(userTabId);
  assert.equal(userMarker.title, 'Browser Relay');
  assert.equal(userMarker.color, 'orange');
  console.log('ok  toolbar toggle attaches and visibly groups the tab');

  // 3. MCP server drives the attached tab and opens a new one.
  const mcp = spawn(process.execPath, [join(ROOT, 'bin/browser-relay'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  cleanup.unshift(() => mcp.kill());
  const call = rpcClient(mcp);
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.serverInfo.name, 'browser-relay');
  const { tools } = await call('tools/list');
  assert.deepEqual(tools.map((t) => t.name), ['session', 'execute', 'reset']);

  const sessionCall = async (args) => {
    const result = await call('tools/call', { name: 'session', arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const sessionA = await sessionCall({ action: 'create', name: 'Checkout test' });
  assert.equal(await upgradeStatus('/cdp', { authorization: `Bearer ${token}` }), 403, 'CDP requires session identity');
  assert.match((await call('tools/call', { name: 'execute', arguments: { code: 'return page' } })).content[0].text, /sessionId is required/);
  const available = await sessionCall({ action: 'list' });
  assert.equal(available.tabs[0].tabId, userTabId);
  const beforeClaim = await call('tools/call', { name: 'execute', arguments: { sessionId: sessionA.id, code: 'return [page, context.pages().length]' } });
  assert.match(beforeClaim.content[0].text, /null, 0/);
  await sessionCall({ action: 'claim', sessionId: sessionA.id, tabId: userTabId });
  const claimedMarker = await marker(userTabId);
  assert.equal(claimedMarker.title, 'Browser Relay · This computer · Checkout test');
  const exec = async (code) => {
    const res = await call('tools/call', { name: 'execute', arguments: { sessionId: sessionA.id, code } });
    if (res.isError) throw new Error(res.content[0].text);
    return res.content;
  };
  assert.match((await exec('return await page.title()'))[0].text, /attached-by-user/);
  console.log('ok  execute reads the attached tab');

  const created = await exec(`const p = await context.newPage(); await p.goto(${JSON.stringify(siteUrl('opened-by-agent'))}); setPage(p); console.log('pages', context.pages().length); return p.title()`);
  assert.match(created[0].text, /pages 2/);
  assert.match(created[0].text, /opened-by-agent/);
  assert.equal((await health()).tabs, 2);
  const agentTabId = await sw.evaluate((userId) => [...attached.keys()].find((id) => id !== userId), userTabId);
  assert.equal((await marker(agentTabId)).groupId, claimedMarker.groupId);
  console.log('ok  context.newPage opens and marks a new tab in the relay group');

  assert.match((await exec(`state.n = (state.n ?? 0) + 1; return page.url()`))[0].text, /opened-by-agent/);
  assert.match((await exec(`return state.n`))[0].text, /Return value: 1/);
  console.log('ok  setPage and state persist between calls');

  const shot = await exec('return await page.screenshot()');
  assert.equal(shot[0].type, 'image');
  assert.equal(shot[0].mimeType, 'image/png');
  console.log('ok  screenshots come back as images');

  await exec('await page.close()');
  await waitUntil(async () => (await health()).tabs === 1, 'agent tab closed');
  console.log('ok  page.close closes the tab');

  const err = await call('tools/call', { name: 'execute', arguments: { sessionId: sessionA.id, code: 'throw new Error("boom")' } });
  assert.equal(err.isError, true);
  console.log('ok  errors are reported, not fatal');

  // 127.0.0.1 and localhost are different sites, so the iframe runs out of process
  // and is reached through a nested CDP session.
  const framed = siteUrl('outer').replace('/outer', `/?frame`);
  const innerUrl = siteUrl('inner-frame').replace('127.0.0.1', 'localhost');
  site.removeAllListeners('request');
  site.on('request', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/?frame' ? `<title>outer</title><iframe src="${innerUrl}"></iframe>` : `<title>inner</title><p id="x">inside ${req.url}</p>`);
  });
  await sw.evaluate(() => {
    globalThis.testChildSession = null;
    chrome.debugger.onEvent.addListener((_source, method, params) => {
      if (method === 'Target.attachedToTarget') globalThis.testChildSession = params.sessionId;
    });
  });
  const frameText = await exec(
    `setPage(null); await page.goto(${JSON.stringify(framed)}); const f = page.frames().find(f => f.url().includes('inner-frame')); return await f.locator('#x').textContent()`,
  );
  assert.match(frameText[0].text, /inside \/inner-frame/);
  console.log('ok  cross-site iframes work through nested sessions');

  const restartWorker = async () => {
    const cdp = await testBrowser.newCDPSession(userTab);
    const versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: changed }) => changed.forEach((v) => versions.set(v.versionId, v)));
    await cdp.send('ServiceWorker.enable');
    await waitUntil(async () => [...versions.values()].some((v) => v.scriptURL === sw.url()), 'extension worker version');
    const version = [...versions.values()].find((v) => v.scriptURL === sw.url());
    await sw.evaluate(() => { globalThis.testBootMarker = 'before-stop'; });
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await cdp.send('ServiceWorker.startWorker', { scopeURL: sw.url().replace('background.js', '') });
    await waitUntil(async () => sw.evaluate(async () => { await ready; return globalThis.testBootMarker === undefined && attached.size === 3; }), 'fresh worker execution context');
    await waitUntil(async () => (await health()).extension && (await health()).tabs === 3, 'worker restored owned tabs');
    await cdp.detach();
    return sw;
  };
  await checkSessions({ ROOT, env, PORT, token, call, cleanup, sw, sessionA, userTabId, marker, sessionCall, exec, siteUrl, restartWorker });

  // The extension reconnects to a restarted relay and re-announces its tabs.
  relay.kill();
  await waitUntil(async () => !(await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null)), 'relay down');
  const relay2 = spawn(process.execPath, [join(ROOT, 'bin/browser-relay'), 'serve'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  cleanup.push(() => relay2.kill());
  await waitUntil(async () => (await health()).extension && (await health()).tabs === 1, 'extension back with its tab');
  await call('tools/call', { name: 'reset', arguments: { sessionId: sessionA.id } });
  assert.match((await exec('return await page.title()'))[0].text, /outer/);
  assert.match((await exec("const f = page.frames().find(f => f.url().includes('inner-frame')); return await f.locator('#x').textContent()"))[0].text, /inside \/inner-frame/);
  console.log('ok  extension reconnects after a relay restart');

  await checkRelays({
    ROOT, env, envB, PORT, PORT_B, token, tokenB, publicHostB, serve, relayB, spawnRelayB, cleanup, testBrowser,
    sw, call, exec, sessionA, marker, health, waitUntil, siteUrl,
  });

  await sw.evaluate((id) => toggle(id), userTabId);
  await waitUntil(async () => (await marker(userTabId)).title === 'Research', 'original group restored');
  assert.equal((await marker(userTabId)).color, 'blue');
  await waitUntil(async () => (await health()).tabs === 0, 'tab detached');
  console.log('ok  detach restores a previous group that Chrome removed while empty');

  // Pinned and ungrouped tabs also return to their original state.
  const pinnedTabId = await sw.evaluate(async () => {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false, pinned: true });
    await toggle(tab.id);
    return tab.id;
  });
  assert.equal((await marker(pinnedTabId)).title, 'Browser Relay');
  assert.equal((await marker(pinnedTabId)).pinned, false);
  await sw.evaluate((id) => toggle(id), pinnedTabId);
  await waitUntil(async () => (await marker(pinnedTabId)).pinned, 'original pinned state restored');
  assert.equal((await marker(pinnedTabId)).groupId, -1);
  await sw.evaluate((id) => chrome.tabs.remove(id), pinnedTabId);
  console.log('ok  detach restores pinned and ungrouped tabs');

  const movedTabId = await sw.evaluate(async () => {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await toggle(tab.id);
    await chrome.windows.create({ tabId: tab.id, focused: false });
    return tab.id;
  });
  await waitUntil(async () => (await marker(movedTabId)).title === 'Browser Relay', 'tab marked in new window');
  await sw.evaluate((id) => toggle(id), movedTabId);
  await waitUntil(async () => (await marker(movedTabId)).groupId === -1, 'moved tab ungrouped');
  await sw.evaluate((id) => chrome.tabs.remove(id), movedTabId);
  console.log('ok  controlled tabs remain marked when moved to another window');

  console.log('\nall checks passed');
} finally {
  for (const fn of cleanup) await Promise.resolve().then(fn).catch(() => {});
}

async function health(port = PORT, auth = token) {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${auth}` } });
  return res.json();
}

// fetch() cannot set Host, so simulated tailnet requests use node:http.
function relayRequest(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', () => resolve({ status: 'error' }));
    req.end(method === 'POST' ? '{"action":"list"}' : undefined);
  });
}

// What a request through `tailscale serve` looks like to relay B, and what it may reach.
async function checkPublicHostRules() {
  const auth = { authorization: `Bearer ${tokenB}` };
  const tailnet = (login, extra = {}) => ({ host: publicHostB, 'tailscale-user-login': login, ...extra });
  const status = async (path, headers, method) => (await relayRequest(PORT_B, path, headers, method)).status;
  assert.equal(await status('/health', { ...auth, host: publicHostB }), 403, 'public host needs a Tailscale login');
  assert.equal(await status('/health', { ...auth, ...tailnet('mallory@example.com') }), 403, 'login must be allowed');
  assert.equal(await status('/health', { ...auth, ...tailnet('alice@example.com', { 'tailscale-funnel-request': '?1' }) }), 403, 'Funnel requests are refused');
  assert.equal(await status('/health', { ...auth, host: 'relay-b.test:1' }), 403, 'other ports are foreign hosts');
  assert.equal(await status('/health', tailnet('alice@example.com')), 401, 'tailnet requests still need the token');
  assert.equal(await status('/health', { authorization: `Bearer ${token}`, ...tailnet('alice@example.com') }), 401, 'each relay has its own token');
  assert.equal(await status('/health', { ...auth, ...tailnet('ALICE@example.com') }), 200, 'allowed login reaches health');
  assert.equal(await status('/sessions', { ...auth, ...tailnet('alice@example.com'), 'content-type': 'application/json' }, 'POST'), 403, 'sessions are loopback-only');
  assert.equal(await status('/shutdown', { ...auth, ...tailnet('alice@example.com') }, 'POST'), 403, 'shutdown is loopback-only');
  assert.equal(await status('/health', { ...auth, 'tailscale-user-login': 'mallory@example.com' }), 200, 'loopback ignores Tailscale headers');

  const session = JSON.parse(await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT_B, path: '/sessions', method: 'POST', headers: auth }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c)).on('end', () => resolve(body));
    });
    req.end('{"action":"create","name":"probe"}');
  }));
  const extensionOrigin = { origin: 'chrome-extension://abc' };
  assert.equal(await upgradeStatus('/cdp', { ...auth, ...tailnet('alice@example.com'), 'x-browser-relay-session': session.id }, PORT_B), 403, 'cdp is loopback-only');
  assert.equal(await upgradeStatus(`/extension?token=${tokenB}`, { ...extensionOrigin, host: publicHostB }, PORT_B), 403, 'extension over the tailnet needs a login');
  assert.equal(await upgradeStatus(`/extension?token=${tokenB}`, { ...extensionOrigin, ...tailnet('mallory@example.com') }, PORT_B), 403);
  assert.equal(await upgradeStatus(`/extension?token=${token}`, { ...extensionOrigin, ...tailnet('alice@example.com') }, PORT_B), 401);
  assert.equal(await upgradeStatus(`/extension?token=${tokenB}`, { origin: 'https://evil.example', ...tailnet('alice@example.com') }, PORT_B), 403);

  // A relay keeps tabs owned by sessions it does not know out of its list.
  const ext = new WebSocket(`ws://127.0.0.1:${PORT_B}/extension?token=${tokenB}`, { headers: { ...extensionOrigin, ...tailnet('alice@example.com') } });
  await new Promise((resolve, reject) => { ext.once('open', resolve); ext.once('error', reject); });
  ext.send(JSON.stringify({ event: 'tabAttached', tabId: 1, targetInfo: { targetId: 'one', url: 'about:blank' }, owner: { id: 'not-mine', name: 'x' } }));
  ext.send(JSON.stringify({ event: 'tabAttached', tabId: 2, targetInfo: { targetId: 'two', url: 'about:blank' }, owner: null }));
  await waitUntil(async () => (await health(PORT_B, tokenB)).tabs === 1, 'only the unowned tab is listed');
  ext.close();
  await waitUntil(async () => !(await health(PORT_B, tokenB)).extension, 'probe extension gone');
  console.log('ok  public hosts need an allowed Tailscale login and the token, and only reach /extension and /health');
}

async function waitUntil(check, label, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function rpcClient(child) {
  let seq = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}
