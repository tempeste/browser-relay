import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdp, rpcClient } from './sessions.mjs';

// A stand-in for `tailscale serve`: terminates TLS, keeps the Host header, drops any
// Tailscale-* headers the client sent and names the caller with its own.
export async function fakeTailscaleServe(targetPort, login) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-relay-cert-'));
  let key;
  let cert;
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=relay-b.test',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    key = readFileSync(join(dir, 'key.pem'));
    cert = readFileSync(join(dir, 'cert.pem'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const server = https.createServer({ key, cert });
  const sockets = new Set();
  const serve = { login, port: 0, close: () => { sockets.forEach((s) => s.destroy()); server.close(); } };
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    const end = () => { socket.destroy(); upstream.destroy(); };
    for (const s of [socket, upstream]) {
      sockets.add(s);
      s.on('error', end).on('close', () => { sockets.delete(s); end(); });
    }
    const headers = Object.entries(req.headers).filter(([name]) => !name.startsWith('tailscale-'));
    if (serve.login) headers.push(['tailscale-user-login', serve.login]);
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serve.port = server.address().port;
  return serve;
}

// One extension, two relays with different tokens: "This computer" on ws://127.0.0.1
// and relay-b on wss://, as Chrome on a Mac would reach a relay on a tailnet VM.
export async function checkRelays({
  ROOT, env, envB, PORT, PORT_B, token, tokenB, publicHostB, serve, relayB, spawnRelayB, cleanup, testBrowser,
  sw, call, exec, sessionA, marker, health, waitUntil, siteUrl,
}) {
  const healthB = () => health(PORT_B, tokenB);
  const status = () => sw.evaluate(async () => (await chrome.storage.session.get('relayStatus')).relayStatus);
  const tooltip = (tabId) => sw.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId);

  // Only allowed Tailscale logins get through; the local relay doesn't notice.
  serve.login = 'mallory@example.com';
  await sw.evaluate(async ({ url, token }) => {
    const { relays } = await chrome.storage.local.get('relays');
    await chrome.storage.local.set({ relays: validateRelays([...relays, { id: 'remote', name: 'relay-b', url, token }]) });
  }, { url: `wss://${publicHostB}`, token: tokenB });
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal((await healthB()).extension, false, 'a login outside the allowlist cannot connect');
  assert.notEqual((await status()).remote, 'connected');
  assert.equal((await health()).extension, true);
  serve.login = 'alice@example.com';
  await sw.evaluate(() => connect()); // what the 30s alarm does
  await waitUntil(async () => (await healthB()).extension, 'extension connected to relay B over wss');
  await waitUntil(async () => JSON.stringify(await status()) === '{"local":"connected","remote":"connected"}', 'both relays connected');
  console.log('ok  a wss:// relay connects through the tailnet proxy only for an allowed login, next to the local relay');

  // ws:// is only for this computer; the options page refuses it for other hosts.
  const validation = await sw.evaluate(() => {
    const error = (fn) => { try { fn(); return null; } catch (err) { return err.message; } };
    return {
      bad: ['ws://relay-b.test:1', 'ws://100.81.249.43:19988', 'http://127.0.0.1:1', 'wss://relay-b.test:1/extension', 'wss://u:p@relay-b.test:1', 'nope']
        .map((url) => error(() => relayOrigin(url))),
      good: ['wss://Relay-B.test:19443/', 'ws://localhost:19988', 'ws://[::1]:1', 'wss://127.0.0.1:2'].map(relayOrigin),
      duplicate: error(() => validateRelays([{ name: 'a', url: 'ws://127.0.0.1:1' }, { name: 'b', url: 'ws://127.0.0.1:1/' }])),
      dot: error(() => validateRelays([{ name: 'a · b', url: 'ws://127.0.0.1:1' }])),
    };
  });
  assert.ok(validation.bad.every(Boolean), JSON.stringify(validation.bad));
  assert.match(validation.bad[0], /needs wss:\/\//);
  assert.deepEqual(validation.good, ['wss://relay-b.test:19443', 'ws://localhost:19988', 'ws://[::1]:1', 'wss://127.0.0.1:2']);
  assert.match(validation.duplicate, /already in the list/);
  assert.match(validation.dot, /1–40 printable/);

  const options = await testBrowser.newPage();
  await options.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await waitUntil(async () => (await options.locator('fieldset .status').allTextContents()).join() === '· connected,· connected', 'options show both relays connected');
  assert.deepEqual(await options.locator('fieldset .title').allTextContents(), ['This computer', 'relay-b']);
  assert.equal(await options.locator('input[name="token"]').first().inputValue(), '', 'saved tokens are not shown');
  await options.click('#add');
  const added = options.locator('fieldset').nth(2);
  await added.locator('[name="name"]').fill('elsewhere');
  await added.locator('[name="url"]').fill('ws://relay-b.test:19443');
  await added.locator('[name="token"]').fill('x');
  await added.locator('.save').click();
  await waitUntil(async () => /needs wss:\/\//.test(await added.locator('.message').textContent()), 'options page rejects ws:// to another host');
  assert.equal((await sw.evaluate(() => chrome.storage.local.get('relays'))).relays.length, 2);
  await options.close();
  console.log('ok  relay URLs need wss:// unless they are loopback, in the worker and the options page');

  // A second MCP server, as an agent on the other machine would run against relay B.
  const mcpB = spawn(process.execPath, [join(ROOT, 'bin/browser-relay'), 'mcp'], { env: envB, stdio: ['pipe', 'pipe', 'inherit'] });
  cleanup.unshift(() => mcpB.kill());
  const callB = rpcClient(mcpB);
  const tool = async (rpc, name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return name === 'session' ? JSON.parse(result.content[0].text) : result.content;
  };
  const sessionB = await tool(callB, 'session', { action: 'create', name: 'Remote task' });
  const execB = (code) => tool(callB, 'execute', { sessionId: sessionB.id, code });
  const listA = async () => (await tool(call, 'session', { action: 'list', sessionId: sessionA.id })).tabs.map((t) => t.tabId);
  const listB = async () => (await tool(callB, 'session', { action: 'list', sessionId: sessionB.id })).tabs.map((t) => t.tabId);
  const attachNew = (path) => sw.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    await new Promise((r) => setTimeout(r, 300));
    await toggle(tab.id);
    return tab.id;
  }, siteUrl(path));

  // An attached tab is offered to both relays, and the first claim wins.
  const sharedId = await attachNew('shared');
  assert.ok((await listA()).includes(sharedId));
  assert.ok((await listB()).includes(sharedId));
  const race = await Promise.allSettled([
    tool(call, 'session', { action: 'claim', sessionId: sessionA.id, tabId: sharedId }),
    tool(callB, 'session', { action: 'claim', sessionId: sessionB.id, tabId: sharedId }),
  ]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one relay wins a claim race');
  const aWon = race[0].status === 'fulfilled';
  assert.equal((await listA()).includes(sharedId), aWon);
  assert.equal((await listB()).includes(sharedId), !aWon);
  await tool(aWon ? call : callB, 'session', { action: 'release', sessionId: (aWon ? sessionA : sessionB).id, tabId: sharedId });
  await sw.evaluate((id) => toggle(id), sharedId);
  await tool(callB, 'session', { action: 'claim', sessionId: sessionB.id, tabId: sharedId });
  await assert.rejects(tool(call, 'session', { action: 'claim', sessionId: sessionA.id, tabId: sharedId }), /another relay/);
  assert.equal((await marker(sharedId)).title, 'Browser Relay · relay-b · Remote task');
  assert.match(await tooltip(sharedId), /owned by Remote task on relay-b\./);
  console.log('ok  attached tabs are offered to every relay and the first claim wins');

  // Each relay sees, commands and hears only its own tabs.
  assert.match((await execB('return page.url()'))[0].text, /shared/);
  assert.match((await execB(`const p = await context.newPage(); await p.goto(${JSON.stringify(siteUrl('opened-by-b'))}); setPage(p); return context.pages().length`))[0].text, /Return value: 2/);
  const bTabs = await listB();
  const openedId = bTabs.find((id) => id !== sharedId);
  assert.deepEqual(bTabs.sort(), [sharedId, openedId].sort());
  assert.equal((await marker(openedId)).groupId, (await marker(sharedId)).groupId);
  const aTabs = await listA();
  assert.ok(!aTabs.includes(sharedId) && !aTabs.includes(openedId), 'relay A never lists relay B tabs');
  assert.ok(aTabs.every((id) => !bTabs.includes(id)));
  assert.match((await exec('return context.pages().length'))[0].text, /Return value: 1/);

  const { ws, command, events } = await cdp(PORT, token, sessionA.id);
  try {
    await command('Target.setAutoAttach', { autoAttach: true, flatten: true });
    assert.equal((await command('Target.getTargets')).result.targetInfos.length, 1);
    assert.ok((await command('Runtime.evaluate', { expression: '1' }, `tab-${sharedId}`)).error);
    assert.ok((await command('Runtime.evaluate', { expression: '1' }, `tab-${openedId}`)).error);
    await execB('await page.evaluate(() => console.log("relay B event")); await page.reload()');
    assert.ok(events.every((e) => ![`tab-${sharedId}`, `tab-${openedId}`].includes(e.sessionId)), 'relay A hears no relay B events');
    assert.ok(!JSON.stringify(events).includes('opened-by-b'));
  } finally { ws.close(); }

  // Even a relay that knew another relay's session ID is refused by the extension.
  const refused = await sw.evaluate(async ({ tabId, owner }) => {
    const replies = [];
    const sock = { readyState: WebSocket.OPEN, send: (msg) => replies.push(JSON.parse(msg)) };
    await handle('local', sock, { id: 1, method: 'cdp', params: { tabId, owner, method: 'Runtime.evaluate', params: { expression: '1' } } });
    await handle('local', sock, { id: 2, method: 'closeTab', params: { tabId, owner } });
    await handle('local', sock, { id: 3, method: 'releaseTab', params: { tabId, owner } });
    await handle('local', sock, { id: 4, method: 'claimTab', params: { tabId, owner: { id: 'x', name: 'x' } } });
    await handle('local', sock, { id: 5, method: 'listTabs', params: {} });
    return replies;
  }, { tabId: sharedId, owner: { id: sessionB.id, name: 'Remote task' } });
  assert.match(refused[0].error, /not owned by this session/);
  assert.match(refused[1].error, /not owned by this session/);
  assert.match(refused[2].error, /not owned by this session/);
  assert.match(refused[3].error, /already owned/);
  assert.ok(refused[4].result.every((t) => t.tabId !== sharedId && t.tabId !== openedId));
  console.log('ok  tabs, CDP events and commands stay with the relay that owns them, including tabs it opened');

  // Restarting relay B leaves relay A and every tab's ownership alone.
  relayB.process.kill();
  await waitUntil(async () => !(await healthB().catch(() => null)), 'relay B down');
  await waitUntil(async () => /its relay is offline/.test(await tooltip(sharedId)), 'relay B tabs marked offline');
  assert.match((await exec('return await page.title()'))[0].text, /outer/);
  assert.equal((await health()).extension, true);
  assert.equal((await marker(sharedId)).title, 'Browser Relay · relay-b · Remote task');
  relayB.process = spawnRelayB();
  await waitUntil(async () => (await healthB()).extension && (await healthB()).tabs === 2, 'relay B back with its tabs', 40_000);
  await tool(callB, 'reset', { sessionId: sessionB.id });
  assert.match((await execB('return context.pages().length'))[0].text, /Return value: 2/);
  console.log('ok  restarting one relay does not disturb the other relay or its tabs');

  // Stopping relay A leaves relay B alone, too.
  await fetch(`http://127.0.0.1:${PORT}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await waitUntil(async () => !(await health().catch(() => null)), 'relay A down');
  assert.match((await execB('return page.url()'))[0].text, /opened-by-b/);
  assert.equal((await healthB()).tabs, 2);
  const relayA = spawn(process.execPath, [join(ROOT, 'bin/browser-relay'), 'serve'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  cleanup.push(() => relayA.kill());
  await waitUntil(async () => (await health()).extension && (await health()).tabs === 1, 'relay A back with its tab', 40_000);
  await tool(call, 'reset', { sessionId: sessionA.id });
  assert.match((await exec('return await page.title()'))[0].text, /outer/);

  // Renaming a relay retitles its groups; removing it releases its tabs.
  await sw.evaluate(async () => {
    const { relays } = await chrome.storage.local.get('relays');
    await chrome.storage.local.set({ relays: relays.map((r) => (r.id === 'remote' ? { ...r, name: 'relay-b2' } : r)) });
  });
  await waitUntil(async () => (await marker(openedId)).title === 'Browser Relay · relay-b2 · Remote task', 'group renamed');
  await sw.evaluate(async () => {
    const { relays } = await chrome.storage.local.get('relays');
    await chrome.storage.local.set({ relays: relays.filter((r) => r.id !== 'remote') });
  });
  await waitUntil(async () => !(await healthB()).extension, 'relay B disconnected');
  await waitUntil(async () => (await marker(sharedId)).groupId === -1 && (await marker(openedId)).groupId === -1, 'relay B tabs released');
  assert.equal(await sw.evaluate((ids) => ids.some((id) => attached.has(id)), [sharedId, openedId]), false);
  assert.deepEqual(await status(), { local: 'connected' });
  assert.match((await exec('return await page.title()'))[0].text, /outer/);
  await sw.evaluate((ids) => chrome.tabs.remove(ids), [sharedId, openedId]);
  mcpB.kill();
  console.log('ok  stopping relay A spares relay B; renaming retitles groups; removing a relay releases only its tabs');
}
