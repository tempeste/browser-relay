// Browser Relay service worker.
//
// Clicking the toolbar button attaches chrome.debugger to that tab and exposes it
// to the local relay (ws://127.0.0.1). The relay can also ask for new tabs, which
// are attached automatically. The only network endpoint this file ever talks to is
// the relay on 127.0.0.1. Chrome shows its "being debugged" bar on every attached
// tab; pressing Cancel there detaches it.

const DEFAULT_PORT = 19988;
const PING_MS = 20_000;
const RETRY_MS = 2_000;

let ws = null;
let connecting = false;
let pingTimer = null;
const attached = new Map(); // tabId -> targetInfo
const ready = restoreAttached();

// Listeners must be registered synchronously so events wake the worker.
chrome.action.onClicked.addListener((tab) => toggle(tab.id));
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
// Wakes the worker every 30s so it reconnects after a relay restart.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.token && !changes.port) return;
  ws?.close();
  connect();
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!attached.has(source.tabId)) return;
  send({ event: 'cdp', tabId: source.tabId, sessionId: source.sessionId, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) forget(source.tabId, reason);
});

connect();

async function settings() {
  const { token, port } = await chrome.storage.local.get(['token', 'port']);
  return { token, port: Number(port) || DEFAULT_PORT };
}

async function connect() {
  await ready;
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  const { token, port } = await settings();
  if (!token) return updateTitle('Browser Relay: set the token in the extension options');
  connecting = true;
  const sock = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(token)}`);
  sock.onopen = () => {
    connecting = false;
    ws = sock;
    updateTitle('Browser Relay: connected. Click to attach or detach this tab');
    for (const [tabId, targetInfo] of attached) send({ event: 'tabAttached', tabId, targetInfo });
    // Traffic on the socket keeps the service worker alive (Chrome 116+).
    pingTimer = setInterval(() => send({ event: 'ping' }), PING_MS);
  };
  sock.onmessage = (e) => handle(JSON.parse(e.data));
  sock.onerror = () => {};
  sock.onclose = () => {
    connecting = false;
    if (ws === sock) ws = null;
    clearInterval(pingTimer);
    updateTitle('Browser Relay: relay not running');
    setTimeout(connect, RETRY_MS);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handle({ id, method, params }) {
  try {
    let result = {};
    if (method === 'cdp') {
      if (!attached.has(params.tabId)) throw new Error(`tab ${params.tabId} is not attached`);
      const target = { tabId: params.tabId, sessionId: params.sessionId };
      result = await chrome.debugger.sendCommand(target, params.method, params.params);
    } else if (method === 'createTab') {
      const tab = await chrome.tabs.create({ url: params.url, active: false });
      result = { tabId: tab.id, targetInfo: await attach(tab.id, { announce: false }) };
    } else if (method === 'closeTab') {
      await chrome.tabs.remove(params.tabId);
    } else if (method === 'activateTab') {
      const tab = await chrome.tabs.update(params.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      throw new Error(`unknown method ${method}`);
    }
    send({ id, result: result ?? {} });
  } catch (err) {
    send({ id, error: String(err?.message ?? err) });
  }
}

async function toggle(tabId) {
  await ready;
  const { token } = await settings();
  if (!token) return chrome.runtime.openOptionsPage();
  if (attached.has(tabId)) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    return forget(tabId, 'detached by user');
  }
  try {
    await attach(tabId);
    connect();
  } catch (err) {
    await chrome.action.setBadgeText({ tabId, text: 'ERR' });
    updateTitle(`Browser Relay: could not attach (${err.message})`, tabId);
  }
}

async function attach(tabId, { announce = true } = {}) {
  await chrome.debugger.attach({ tabId }, '1.3');
  const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
  attached.set(tabId, targetInfo);
  await persist();
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  await chrome.action.setBadgeText({ tabId, text: 'ON' });
  if (announce) send({ event: 'tabAttached', tabId, targetInfo });
  return targetInfo;
}

async function forget(tabId, reason) {
  if (!attached.delete(tabId)) return;
  await persist();
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  send({ event: 'tabDetached', tabId, reason });
}

// The worker can be stopped and restarted while debugger sessions stay attached,
// so the attached-tab list lives in session storage and is re-checked on wake.
async function restoreAttached() {
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  for (const [key, targetInfo] of Object.entries(tabs)) {
    const tabId = Number(key);
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      attached.set(tabId, targetInfo);
    } catch {
      // No longer attached (tab closed, browser restarted, or the user pressed Cancel).
    }
  }
  await persist();
}

function persist() {
  return chrome.storage.session.set({ tabs: Object.fromEntries(attached) });
}

function updateTitle(title, tabId) {
  chrome.action.setTitle(tabId === undefined ? { title } : { title, tabId }).catch(() => {});
}
