// The relay sits between the Chrome extension and CDP clients such as Playwright.
//
//   Playwright --(/cdp, CDP JSON)--> relay --(/extension, small RPC)--> extension --chrome.debugger--> tab
//
// To Playwright it looks like a normal Chrome whose only pages are owned by the
// named session selected in the connection header. Each attached tab is exposed
// as a flat CDP session named `tab-<tabId>`.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { HOST, PORT, loadToken, tokensMatch } from './config.mjs';
import { Sessions } from './sessions.mjs';

const EXTENSION_TIMEOUT_MS = 30_000;

export function startRelay({ port = PORT, token = loadToken(), log = defaultLog } = {}) {
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

  const sessions = new Sessions();
  let managementQueue = Promise.resolve();
  let extension = null;
  let extSeq = 0;
  const extPending = new Map(); // relay request id -> { resolve, reject, timer }
  const clients = new Set(); // { ws, owner, autoAttach }
  const tabs = new Map(); // tabId -> { sessionId (CDP), targetInfo, owner (named session) }
  const childSessions = new Map(); // nested CDP sessionId (iframe, worker) -> tabId
  const childAttachments = new Map(); // nested CDP sessionId -> attachment event for reconnecting clients

  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  function sendEvent(client, msg) {
    if (msg.method === 'Target.attachedToTarget') client.seenChildren.add(msg.params.sessionId);
    if (msg.method === 'Target.detachedFromTarget') client.seenChildren.delete(msg.params.sessionId);
    send(client.ws, msg);
  }
  const broadcast = (tab, msg) => clients.forEach((c) => c.autoAttach && c.owner.id === tab.owner?.id && sendEvent(c, msg));

  function callExtension(method, params = {}) {
    if (!extension) return Promise.reject(new Error('Browser Relay extension is not connected to the relay'));
    const id = ++extSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        extPending.delete(id);
        reject(new Error(`extension did not answer ${method} within ${EXTENSION_TIMEOUT_MS / 1000}s`));
      }, EXTENSION_TIMEOUT_MS);
      extPending.set(id, { resolve, reject, timer });
      send(extension, { id, method, params });
    });
  }

  const attachedEvent = (tab) => ({
    method: 'Target.attachedToTarget',
    params: { sessionId: tab.sessionId, targetInfo: { ...tab.targetInfo, attached: true }, waitingForDebugger: false },
  });

  function addTab(tabId, targetInfo, owner = null) {
    const existing = tabs.get(tabId);
    if (existing && existing.targetInfo.targetId === targetInfo.targetId && existing.owner?.id === owner?.id) {
      existing.targetInfo = targetInfo;
      return existing;
    }
    if (existing) removeTab(tabId, 'attachment or ownership changed');
    const tab = { sessionId: `tab-${tabId}`, targetInfo, owner };
    tabs.set(tabId, tab);
    broadcast(tab, attachedEvent(tab));
    log(`tab ${tabId} attached: ${targetInfo.url}`);
    return tab;
  }

  function removeTab(tabId, reason) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tabs.delete(tabId);
    for (const [sid, owner] of childSessions) if (owner === tabId) {
      childSessions.delete(sid);
      childAttachments.delete(sid);
      for (const client of clients) client.seenChildren.delete(sid);
    }
    broadcast(tab, { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetInfo.targetId } });
    log(`tab ${tabId} detached (${reason ?? 'unknown'})`);
  }

  const tabByTargetId = (targetId) => [...tabs].find(([, t]) => t.targetInfo.targetId === targetId)?.[0];

  function ownedTab(client, tabId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.owner?.id !== client.owner.id) throw new Error('Tab is not owned by this session');
    return tab;
  }

  // Serialize claims and releases so two callers cannot claim the same tab.
  function manage(task) {
    const result = managementQueue.then(task);
    managementQueue = result.catch(() => {});
    return result;
  }

  async function sessionRequest({ action, sessionId, name, tabId }) {
    if (action === 'create') return sessions.create(name);
    if (action === 'list') {
      if (extension) {
        for (const tab of await callExtension('listTabs')) {
          const known = addTab(tab.tabId, tab.targetInfo, tab.owner);
          known.targetInfo = tab.targetInfo;
        }
      }
      const owner = sessionId ? sessions.get(sessionId) : null;
      return {
        sessions: [...sessions.items.values()],
        tabs: [...tabs].filter(([, t]) => !t.owner || t.owner.id === owner?.id)
          .map(([id, t]) => ({ tabId: id, title: t.targetInfo.title, url: t.targetInfo.url, owner: t.owner })),
      };
    }
    const owner = sessions.get(sessionId);
    // A fresh snapshot also covers tabs announced just after reconnecting.
    const snapshot = await callExtension('listTabs');
    for (const tab of snapshot) {
      const known = addTab(tab.tabId, tab.targetInfo, tab.owner);
      known.targetInfo = tab.targetInfo;
    }
    for (const id of tabs.keys()) if (!snapshot.some((t) => t.tabId === id)) removeTab(id, 'no longer attached');
    if (action === 'claim') {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('Tab is not attached; click its toolbar button first');
      if (tab.owner?.id === owner.id) return { tabId, owner };
      if (tab.owner) throw new Error('Tab is already owned by another session');
      await callExtension('claimTab', { tabId, owner });
      addTab(tabId, tab.targetInfo, owner);
      return { tabId, owner };
    }
    if (action === 'release' || action === 'close') {
      const ids = action === 'close'
        ? [...tabs].filter(([, t]) => t.owner?.id === owner.id).map(([id]) => id) : [tabId];
      for (const id of ids) {
        ownedTab({ owner }, id);
        await callExtension('releaseTab', { tabId: id, owner });
        removeTab(id, 'released');
      }
      if (action === 'close') {
        sessions.remove(owner.id);
        for (const client of clients) if (client.owner.id === owner.id) client.ws.close(4001, 'session closed');
      }
      return { released: ids };
    }
    throw new Error('Unknown session action');
  }

  // Commands without a sessionId are browser-level. chrome.debugger cannot reach the
  // browser target, so the few that Playwright needs are answered here.
  async function browserCommand(client, method, params) {
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: 'Chrome/BrowserRelay', revision: '', userAgent: 'BrowserRelay', jsVersion: '' };
      case 'Browser.setDownloadBehavior':
      case 'Browser.close':
      case 'Target.setDiscoverTargets':
        return {};
      case 'Target.setAutoAttach':
        client.autoAttach = true;
        tabs.forEach((tab) => { if (tab.owner?.id === client.owner.id) sendEvent(client, attachedEvent(tab)); });
        return {};
      case 'Target.getTargets':
        return { targetInfos: [...tabs.values()].filter((t) => t.owner?.id === client.owner.id).map((t) => ({ ...t.targetInfo, attached: true })) };
      case 'Target.getTargetInfo': {
        const tabId = tabByTargetId(params.targetId);
        if (params.targetId) return { targetInfo: ownedTab(client, tabId).targetInfo };
        return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      }
      case 'Target.createTarget': {
        // Playwright expects Target.attachedToTarget before this response arrives.
        const { tabId, targetInfo } = await manage(async () => {
          sessions.get(client.owner.id);
          const created = await callExtension('createTab', { url: params.url || 'about:blank', owner: client.owner });
          addTab(created.tabId, created.targetInfo, client.owner);
          return created;
        });
        return { targetId: targetInfo.targetId };
      }
      case 'Target.closeTarget':
      case 'Target.activateTarget': {
        const tabId = tabByTargetId(params.targetId);
        if (tabId === undefined) throw new Error(`No attached tab with targetId ${params.targetId}`);
        ownedTab(client, tabId);
        await callExtension(method === 'Target.closeTarget' ? 'closeTab' : 'activateTab', { tabId, owner: client.owner });
        return method === 'Target.closeTarget' ? { success: true } : {};
      }
      default:
        throw new Error(`${method} is not supported at browser level by browser-relay`);
    }
  }

  async function sessionCommand(client, sessionId, method, params) {
    const tabId = sessionId.startsWith('tab-') ? Number(sessionId.slice(4)) : childSessions.get(sessionId);
    const tab = ownedTab(client, tabId);
    if (method.startsWith('Browser.') || (method.startsWith('Target.') &&
        !['Target.setAutoAttach', 'Target.getTargetInfo'].includes(method))) {
      throw new Error(`${method} is not allowed through a tab session`);
    }
    if (method === 'Target.getTargetInfo' && params.targetId && params.targetId !== tab.targetInfo.targetId) {
      throw new Error('Target is not owned by this session');
    }
    const childSession = sessionId === tab.sessionId ? undefined : sessionId;
    const result = await callExtension('cdp', { tabId, owner: client.owner, sessionId: childSession, method, params });
    if (method === 'Target.setAutoAttach' && params.autoAttach) {
      // chrome.debugger keeps children attached between CDP client connections.
      // Replay only after the client installs its renderer listeners.
      for (const [id, event] of childAttachments) {
        if (childSessions.get(id) === tabId && event.sessionId === sessionId && !client.seenChildren.has(id)) {
          sendEvent(client, event);
        }
      }
    }
    return result;
  }

  function onClient(ws, owner) {
    const client = { ws, owner, autoAttach: false, seenChildren: new Set() };
    clients.add(client);
    log(`cdp client connected (${clients.size} total)`);
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      const { id, method, params = {}, sessionId } = msg;
      try {
        sessions.get(client.owner.id);
        const result = sessionId ? await sessionCommand(client, sessionId, method, params) : await browserCommand(client, method, params);
        send(ws, { id, sessionId, result: result ?? {} });
      } catch (err) {
        send(ws, { id, sessionId, error: { code: -32000, message: err.message } });
      }
    });
    ws.on('close', () => {
      clients.delete(client);
      log(`cdp client disconnected (${clients.size} left)`);
    });
  }

  function onExtension(ws) {
    if (extension) {
      extension.close(4000, 'replaced by a newer extension connection');
      clearExtension('extension connection replaced');
    }
    extension = ws;
    log('extension connected');
    ws.on('message', (data) => {
      if (extension !== ws) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const pending = extPending.get(msg.id);
        if (!pending) return;
        extPending.delete(msg.id);
        clearTimeout(pending.timer);
        msg.error ? pending.reject(new Error(msg.error)) : pending.resolve(msg.result);
        return;
      }
      if (msg.event === 'tabAttached') addTab(msg.tabId, msg.targetInfo, msg.owner);
      else if (msg.event === 'tabDetached') removeTab(msg.tabId, msg.reason);
      else if (msg.event === 'cdp') forwardEvent(msg);
    });
    ws.on('close', () => {
      if (extension !== ws) return;
      extension = null;
      log('extension disconnected');
      clearExtension('extension disconnected');
    });
  }

  function clearExtension(reason) {
    for (const [id, pending] of extPending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      extPending.delete(id);
    }
    [...tabs.keys()].forEach((tabId) => removeTab(tabId, reason));
    for (const client of clients) client.ws.close(4002, reason);
  }

  function forwardEvent({ tabId, sessionId, method, params }) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const event = { method, params, sessionId: sessionId || tab.sessionId };
    if (method === 'Target.attachedToTarget') {
      childSessions.set(params.sessionId, tabId);
      childAttachments.set(params.sessionId, event);
    }
    if (method === 'Target.detachedFromTarget') {
      childSessions.delete(params.sessionId);
      childAttachments.delete(params.sessionId);
    }
    broadcast(tab, event);
  }

  const bearer = (req) => req.headers.authorization?.replace(/^Bearer /, '');

  const server = http.createServer(async (req, res) => {
    // Host check blocks DNS-rebinding; the token check blocks everything else.
    if (req.headers.origin || !allowedHosts.has(req.headers.host) || !tokensMatch(token, bearer(req))) {
      res.writeHead(401).end();
      return;
    }
    const { pathname } = new URL(req.url, 'http://relay');
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, extension: Boolean(extension), tabs: tabs.size, clients: clients.size }));
    } else if (req.method === 'POST' && pathname === '/sessions') {
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 16_384) throw new Error('Request too large');
        }
        const args = JSON.parse(body);
        const result = await manage(() => sessionRequest(args));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      }
    } else if (req.method === 'POST' && pathname === '/shutdown') {
      res.writeHead(200).end();
      log('shutdown requested');
      setImmediate(() => process.exit(0));
    } else {
      res.writeHead(404).end();
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const reject = (code) => {
      socket.end(`HTTP/1.1 ${code} Rejected\r\n\r\n`);
      log(`rejected ${req.url.split('?')[0]} from origin ${req.headers.origin ?? '(none)'}: ${code}`);
    };
    if (!allowedHosts.has(req.headers.host)) return reject(403);
    const url = new URL(req.url, 'http://relay');
    const origin = req.headers.origin;
    if (url.pathname === '/extension') {
      // Browsers can't set headers on WebSockets, so the extension sends the token in the query.
      if (!origin?.startsWith('chrome-extension://')) return reject(403);
      if (!tokensMatch(token, url.searchParams.get('token'))) return reject(401);
      wss.handleUpgrade(req, socket, head, onExtension);
    } else if (url.pathname === '/cdp') {
      // Web pages always send an Origin header; local CDP clients don't.
      if (origin) return reject(403);
      if (!tokensMatch(token, bearer(req))) return reject(401);
      let owner;
      try { owner = sessions.get(req.headers['x-browser-relay-session']); } catch { return reject(403); }
      wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, owner));
    } else {
      reject(404);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      log(`relay listening on ${HOST}:${port}`);
      resolve(server);
    });
  });
}

function defaultLog(line) {
  console.error(`[${new Date().toISOString()}] ${line}`);
}
