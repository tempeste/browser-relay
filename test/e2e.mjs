// End-to-end check in a throwaway Chromium profile, with its own token and port:
// extension -> relay -> MCP server -> Playwright, plus the relay's rejection rules.
// Needs a Chromium that still accepts --load-extension (branded Chrome does not):
//   BROWSER_RELAY_TEST_CHROMIUM=/path/to/Chromium npm test
// Defaults to the newest Playwright-cached Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 19989;
const home = mkdtempSync(join(tmpdir(), 'browser-relay-test-'));
const env = { ...process.env, BROWSER_RELAY_HOME: home, BROWSER_RELAY_PORT: String(PORT) };
// config.mjs reads the environment when it is first imported, so set it before importing.
Object.assign(process.env, env);
const token = (await import('../src/config.mjs')).loadToken();

function findChromium() {
  if (process.env.BROWSER_RELAY_TEST_CHROMIUM) return process.env.BROWSER_RELAY_TEST_CHROMIUM;
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
const cleanup = [];
cleanup.push(() => relay.kill(), () => site.close(), () => rmSync(home, { recursive: true, force: true }));

async function upgradeStatus(path, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers });
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

  // 2. Throwaway browser with the extension, configured through its service worker.
  const profile = mkdtempSync(join(tmpdir(), 'browser-relay-profile-'));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  const ext = join(ROOT, 'extension');
  const testBrowser = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(),
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  cleanup.unshift(() => testBrowser.close());
  const sw = testBrowser.serviceWorkers()[0] ?? (await testBrowser.waitForEvent('serviceworker'));
  await sw.evaluate(({ token, port }) => chrome.storage.local.set({ token, port }), { token, port: PORT });
  await waitUntil(async () => (await health()).extension, 'extension connected');
  console.log('ok  extension connected');

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
      ws.close();
      await Promise.all([connect(), connect()]);
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
  assert.deepEqual(tools.map((t) => t.name), ['execute', 'reset']);

  const exec = async (code) => {
    const res = await call('tools/call', { name: 'execute', arguments: { code } });
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
  assert.equal((await marker(agentTabId)).groupId, userMarker.groupId);
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

  const err = await call('tools/call', { name: 'execute', arguments: { code: 'throw new Error("boom")' } });
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
  const frameText = await exec(
    `setPage(null); await page.goto(${JSON.stringify(framed)}); const f = page.frames().find(f => f.url().includes('inner-frame')); return await f.locator('#x').textContent()`,
  );
  assert.match(frameText[0].text, /inside \/inner-frame/);
  console.log('ok  cross-site iframes work through nested sessions');

  // The extension reconnects to a restarted relay and re-announces its tabs.
  relay.kill();
  await waitUntil(async () => !(await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null)), 'relay down');
  const relay2 = spawn(process.execPath, [join(ROOT, 'bin/browser-relay'), 'serve'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  cleanup.push(() => relay2.kill());
  await waitUntil(async () => (await health()).extension && (await health()).tabs === 1, 'extension back with its tab');
  await call('tools/call', { name: 'reset', arguments: {} });
  assert.match((await exec('return await page.title()'))[0].text, /outer/);
  console.log('ok  extension reconnects after a relay restart');

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

async function health() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { authorization: `Bearer ${token}` } });
  return res.json();
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
