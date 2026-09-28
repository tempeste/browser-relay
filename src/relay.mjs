// The relay sits between the Chrome extension and CDP clients such as Playwright.
//
//   Playwright --(/cdp, CDP JSON)--> relay --(/extension, small RPC)--> extension --chrome.debugger--> tab
//
// To Playwright it looks like a normal Chrome whose only pages are the tabs the
// user attached (or tabs the client itself created). Each attached tab is exposed
// as a flat CDP session named `tab-<tabId>`.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { HOST, PORT, loadToken, tokensMatch } from './config.mjs';

const EXTENSION_TIMEOUT_MS = 30_000;

export function startRelay({ port = PORT, token = loadToken(), log = defaultLog } = {}) {
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

  let extension = null;
  let extSeq = 0;
  const extPending = new Map(); // relay request id -> { resolve, reject, timer }
  const clients = new Set(); // { ws, autoAttach }
  const tabs = new Map(); // tabId -> { sessionId, targetInfo }
  const childSessions = new Map(); // nested CDP sessionId (iframe, worker) -> tabId

  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const broadcast = (msg) => clients.forEach((c) => c.autoAttach && send(c.ws, msg));

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

  function addTab(tabId, targetInfo) {
    if (tabs.has(tabId)) return tabs.get(tabId);
    const tab = { sessionId: `tab-${tabId}`, targetInfo };
    tabs.set(tabId, tab);
    broadcast(attachedEvent(tab));
    log(`tab ${tabId} attached: ${targetInfo.url}`);
    return tab;
  }

  function removeTab(tabId, reason) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tabs.delete(tabId);
    for (const [sid, owner] of childSessions) if (owner === tabId) childSessions.delete(sid);
    broadcast({ method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetInfo.targetId } });
    log(`tab ${tabId} detached (${reason ?? 'unknown'})`);
  }

  const tabByTargetId = (targetId) => [...tabs].find(([, t]) => t.targetInfo.targetId === targetId)?.[0];

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
        tabs.forEach((tab) => send(client.ws, attachedEvent(tab)));
        return {};
      case 'Target.getTargets':
        return { targetInfos: [...tabs.values()].map((t) => ({ ...t.targetInfo, attached: true })) };
      case 'Target.getTargetInfo': {
        const tabId = tabByTargetId(params.targetId);
        if (tabId !== undefined) return { targetInfo: tabs.get(tabId).targetInfo };
        return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      }
      case 'Target.createTarget': {
        // Playwright expects Target.attachedToTarget before this response arrives.
        const { tabId, targetInfo } = await callExtension('createTab', { url: params.url || 'about:blank' });
        addTab(tabId, targetInfo);
        return { targetId: targetInfo.targetId };
      }
      case 'Target.closeTarget':
      case 'Target.activateTarget': {
        const tabId = tabByTargetId(params.targetId);
        if (tabId === undefined) throw new Error(`No attached tab with targetId ${params.targetId}`);
        await callExtension(method === 'Target.closeTarget' ? 'closeTab' : 'activateTab', { tabId });
        return method === 'Target.closeTarget' ? { success: true } : {};
      }
      default:
        throw new Error(`${method} is not supported at browser level by browser-relay`);
    }
  }

  async function sessionCommand(sessionId, method, params) {
    const tabId = sessionId.startsWith('tab-') ? Number(sessionId.slice(4)) : childSessions.get(sessionId);
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Session ${sessionId} is not attached`);
    const childSession = sessionId === tab.sessionId ? undefined : sessionId;
    return callExtension('cdp', { tabId, sessionId: childSession, method, params });
  }

  function onClient(ws) {
    const client = { ws, autoAttach: false };
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
        const result = sessionId ? await sessionCommand(sessionId, method, params) : await browserCommand(client, method, params);
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
    if (extension) extension.close(4000, 'replaced by a newer extension connection');
    extension = ws;
    log('extension connected');
    ws.on('message', (data) => {
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
      if (msg.event === 'tabAttached') addTab(msg.tabId, msg.targetInfo);
      else if (msg.event === 'tabDetached') removeTab(msg.tabId, msg.reason);
      else if (msg.event === 'cdp') forwardEvent(msg);
    });
    ws.on('close', () => {
      if (extension !== ws) return;
      extension = null;
      log('extension disconnected');
      for (const [id, pending] of extPending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('extension disconnected'));
        extPending.delete(id);
      }
      [...tabs.keys()].forEach((tabId) => removeTab(tabId, 'extension disconnected'));
    });
  }

  function forwardEvent({ tabId, sessionId, method, params }) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (method === 'Target.attachedToTarget') childSessions.set(params.sessionId, tabId);
    if (method === 'Target.detachedFromTarget') childSessions.delete(params.sessionId);
    broadcast({ method, params, sessionId: sessionId || tab.sessionId });
  }

  const bearer = (req) => req.headers.authorization?.replace(/^Bearer /, '');

  const server = http.createServer((req, res) => {
    // Host check blocks DNS-rebinding; the token check blocks everything else.
    if (!allowedHosts.has(req.headers.host) || !tokensMatch(token, bearer(req))) {
      res.writeHead(401).end();
      return;
    }
    const { pathname } = new URL(req.url, 'http://relay');
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, extension: Boolean(extension), tabs: tabs.size, clients: clients.size }));
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
      wss.handleUpgrade(req, socket, head, onClient);
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
