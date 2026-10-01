import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

export async function checkSessions({ ROOT, env, PORT, token, call, cleanup, sw, sessionA, userTabId, marker, sessionCall, exec, siteUrl, restartWorker }) {
  const otherMcp = spawn(process.execPath, [join(ROOT, 'bin/browser-relay'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  cleanup.unshift(() => otherMcp.kill());
  const otherCall = rpcClient(otherMcp);
  const tool = (rpc, name, args) => rpc('tools/call', { name, arguments: args });
  const sessionB = JSON.parse((await tool(otherCall, 'session', { action: 'create', name: 'Docs research' })).content[0].text);
  const sessionC = await sessionCall({ action: 'create', name: 'Docs research' });
  const executeB = (code) => tool(otherCall, 'execute', { sessionId: sessionB.id, code });
  const executeC = (code) => tool(call, 'execute', { sessionId: sessionC.id, code });
  const [b, c] = await Promise.all([
    executeB(`state.label = 'B'; const p = await context.newPage(); setPage(p); await p.goto(${JSON.stringify(siteUrl('B'))}); return context.pages().length`),
    executeC(`state.label = 'C'; const p = await context.newPage(); setPage(p); await p.goto(${JSON.stringify(siteUrl('C'))}); return context.pages().length`),
  ]);
  assert.equal(b.isError, undefined, b.content[0].text);
  assert.equal(c.isError, undefined, c.content[0].text);
  assert.match(b.content[0].text, /Return value: 1/);
  assert.match(c.content[0].text, /Return value: 1/);
  assert.match((await executeC('return state.label')) .content[0].text, /Return value: C/);
  assert.match((await executeB('return state.label')) .content[0].text, /Return value: B/);
  assert.match((await exec('return context.pages().length'))[0].text, /Return value: 1/);
  const bTabs = JSON.parse((await tool(otherCall, 'session', { action: 'list', sessionId: sessionB.id })).content[0].text).tabs;
  const cTabs = (await sessionCall({ action: 'list', sessionId: sessionC.id })).tabs;
  assert.equal(bTabs.length, 1);
  assert.equal(cTabs.length, 1);
  const bId = bTabs[0].tabId;
  const cId = cTabs[0].tabId;
  assert.equal((await marker(bId)).title, 'Browser Relay · Docs research');
  assert.notEqual((await marker(bId)).groupId, (await marker(cId)).groupId, 'duplicate labels still have distinct ownership');
  assert.notEqual((await marker(bId)).groupId, (await marker(userTabId)).groupId);
  console.log('ok  two MCP processes and multiple sessions in one process have separate tabs, state and groups');

  // Raw CDP checks prove enforcement below Playwright's filtered page list.
  const { ws, command, events } = await cdp(PORT, token, sessionB.id);
  try {
    await command('Target.setAutoAttach', { autoAttach: true, flatten: true });
    const targetId = await sw.evaluate(async (tabId) => (await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')).targetInfo.targetId, userTabId);
    const childSession = await sw.evaluate(() => globalThis.testChildSession);
    assert.ok(childSession, 'test captured an out-of-process iframe session');
    for (const [method, params, sessionId] of [
      ['Runtime.evaluate', { expression: 'document.title' }, `tab-${userTabId}`],
      ['Runtime.evaluate', { expression: 'document.title' }, childSession],
      ['Target.closeTarget', { targetId }],
      ['Target.activateTarget', { targetId }],
      ['Target.getTargetInfo', { targetId }],
      ['Target.attachToTarget', { targetId, flatten: true }, `tab-${bId}`],
      ['Target.getTargets', {}, `tab-${bId}`],
      ['Browser.close', {}, `tab-${bId}`],
    ]) {
      assert.ok((await command(method, params, sessionId)).error, `${method} must reject another session or an unsupported escape`);
    }
    const listed = (await command('Target.getTargets')).result.targetInfos;
    assert.equal(listed.length, 1);
    assert.notEqual(listed[0].targetId, targetId);
    await exec('console.log(await page.evaluate(() => { console.log("session A event"); return document.title; }))');
    assert.ok(events.every((e) => e.sessionId !== `tab-${userTabId}` && e.sessionId !== childSession && e.params?.targetInfo?.targetId !== targetId));
    const steal = await tool(otherCall, 'session', { action: 'claim', sessionId: sessionB.id, tabId: userTabId });
    assert.equal(steal.isError, true);
    const releaseForeign = await tool(otherCall, 'session', { action: 'release', sessionId: sessionB.id, tabId: userTabId });
    assert.equal(releaseForeign.isError, true);
    console.log('ok  foreign tab commands, iframe commands, claims, releases and events are blocked');
  } finally { ws.close(); }

  sw = await restartWorker();
  assert.match((await exec("const f = page.frames().find(f => f.url().includes('inner-frame')); return await f.locator('#x').textContent()"))[0].text, /inside \/inner-frame/);
  assert.match((await executeB('return context.pages().length')).content[0].text, /Return value: 1/);
  assert.match((await executeC('return context.pages().length')).content[0].text, /Return value: 1/);
  assert.equal((await marker(bId)).title, 'Browser Relay · Docs research');
  assert.notEqual((await marker(bId)).groupId, (await marker(cId)).groupId);
  const tooltip = await sw.evaluate((tabId) => chrome.action.getTitle({ tabId }), bId);
  assert.match(tooltip, /owned by Docs research/);
  console.log('ok  stopping and restarting the extension worker preserves session ownership and groups');

  // Two claims issued together get exactly one winner.
  const raceId = await sw.evaluate(async () => {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await toggle(tab.id);
    return tab.id;
  });
  const race = await Promise.all([
    tool(call, 'session', { action: 'claim', sessionId: sessionC.id, tabId: raceId }),
    tool(otherCall, 'session', { action: 'claim', sessionId: sessionB.id, tabId: raceId }),
  ]);
  assert.equal(race.filter((r) => !r.isError).length, 1);
  const winner = race[0].isError ? sessionB : sessionC;
  await sessionCall({ action: 'release', sessionId: winner.id, tabId: raceId });
  assert.equal((await marker(raceId)).groupId, -1);
  await sw.evaluate((id) => chrome.tabs.remove(id), raceId);

  // Same-session requests serialize; reset touches only that session.
  const serialized = await Promise.all([
    executeC('state.n = 1; await new Promise(r => setTimeout(r, 50)); state.n++; return state.n'),
    executeC('return state.n'),
  ]);
  assert.ok(serialized.every((r) => /Return value: 2/.test(r.content[0].text)));
  await tool(call, 'reset', { sessionId: sessionC.id });
  assert.match((await executeC('return [state.n, context.pages().length]')).content[0].text, /undefined, 1/);
  assert.match((await executeB('return state.label')).content[0].text, /Return value: B/);

  const timedOut = await tool(otherCall, 'execute', {
    sessionId: sessionB.id, code: 'await page.evaluate(() => new Promise(() => {}))', timeout: 100,
  });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /Timed out after 100ms/);
  assert.equal((await executeB('return page')).isError, true, 'timeout requires a reset before retry');
  assert.match((await executeC('return context.pages().length')).content[0].text, /Return value: 1/);
  await tool(otherCall, 'reset', { sessionId: sessionB.id });
  assert.match((await executeB('return [state.label, context.pages().length]')).content[0].text, /undefined, 1/);

  // A process crash keeps its ownership; another process can explicitly resume it.
  otherMcp.kill();
  const resumed = await tool(call, 'execute', { sessionId: sessionB.id, code: 'return context.pages().length' });
  assert.match(resumed.content[0].text, /Return value: 1/);
  await sessionCall({ action: 'close', sessionId: sessionB.id });
  await sessionCall({ action: 'close', sessionId: sessionC.id });
  assert.equal((await marker(bId)).groupId, -1);
  assert.equal((await marker(cId)).groupId, -1);
  const closed = await tool(call, 'execute', { sessionId: sessionC.id, code: 'return page' });
  assert.equal(closed.isError, true);
  assert.match((await exec('return context.pages().length'))[0].text, /Return value: 1/);
  await sw.evaluate((ids) => chrome.tabs.remove(ids), [bId, cId]);
  console.log('ok  claim races, request ordering, reset, process crash, resume and close preserve ownership');
}

async function cdp(port, token, sessionId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp`, { headers: { authorization: `Bearer ${token}`, 'x-browser-relay-session': sessionId } });
  const pending = new Map();
  const events = [];
  let seq = 0;
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id); }
    else events.push(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, events, command: (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  }) };
}

function rpcClient(child) {
  const pending = new Map();
  let seq = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p?.reject(new Error(msg.error.message)) : p?.resolve(msg.result);
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
