// Browser Relay service worker.
//
// Clicking the toolbar button attaches chrome.debugger to that tab and exposes it
// to the local relay (ws://127.0.0.1). The relay can also ask for new tabs, which
// are attached automatically. The only network endpoint this file ever talks to is
// the relay on 127.0.0.1. Controlled tabs have an orange Browser Relay tab group;
// Chrome's browser-wide debugging bar also offers Cancel to detach all tabs.

importScripts('tab-markers.js');

const DEFAULT_PORT = 19988;
const PING_MS = 20_000;
const RETRY_MS = 2_000;

let ws = null;
let connecting = false;
let settingsVersion = 0;
const attached = new Map(); // tabId -> targetInfo
const tabMarkers = new RelayTabMarkers();
const ready = restoreAttached();

// Listeners must be registered synchronously so events wake the worker.
chrome.action.onClicked.addListener((tab) => toggle(tab.id));
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
// Wakes the worker every 30s so it reconnects after a relay restart.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.token && !changes.port) return;
  settingsVersion++;
  ws?.close();
  connect();
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!attached.has(source.tabId)) return;
  send({ event: 'cdp', tabId: source.tabId, sessionId: source.sessionId, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) forget(source.tabId, reason).catch(console.error);
});
chrome.tabs.onAttached.addListener((tabId) => {
  if (attached.has(tabId)) tabMarkers.mark(tabId).catch(console.error);
});
chrome.tabGroups.onRemoved.addListener((group) => tabMarkers.groupRemoved(group.id).catch(console.error));

connect();

async function settings() {
  const { token, port } = await chrome.storage.local.get(['token', 'port']);
  return { token, port: Number(port) || DEFAULT_PORT };
}

async function connect() {
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  const version = settingsVersion;
  try {
    await ready;
    const { token, port } = await settings();
    if (version !== settingsVersion) {
      connecting = false;
      return connect();
    }
    if (!token) {
      connecting = false;
      return updateTitle('Browser Relay: set the token in the extension options');
    }
    const sock = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(token)}`);
    ws = sock;
    let pingTimer = null;
    sock.onopen = () => {
      connecting = false;
      updateTitle('Browser Relay: connected. Click to attach or detach this tab');
      for (const [tabId, targetInfo] of attached) {
        updateAttachedTitle(tabId);
        send({ event: 'tabAttached', tabId, targetInfo });
      }
      // Traffic on this socket keeps the service worker alive (Chrome 116+).
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ event: 'ping' }));
      }, PING_MS);
    };
    sock.onmessage = (e) => handle(JSON.parse(e.data));
    sock.onerror = () => {};
    sock.onclose = () => {
      clearInterval(pingTimer);
      if (ws !== sock) return;
      ws = null;
      connecting = false;
      updateTitle('Browser Relay: relay not running');
      for (const tabId of attached.keys()) updateAttachedTitle(tabId);
      setTimeout(connect, RETRY_MS);
    };
  } catch (err) {
    // A failed storage read or socket construction must not block later alarms.
    connecting = false;
    ws = null;
    updateTitle(`Browser Relay: connection failed (${err.message})`);
    setTimeout(connect, RETRY_MS);
  }
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
  try {
    if (attached.has(tabId)) {
      await chrome.debugger.detach({ tabId });
      return await forget(tabId, 'detached by user');
    }
    await attach(tabId);
    connect();
  } catch (err) {
    await chrome.action.setBadgeText({ tabId, text: 'ERR' });
    updateTitle(`Browser Relay: could not change this tab's attachment (${err.message})`, tabId);
  }
}

async function attach(tabId, { announce = true } = {}) {
  await chrome.debugger.attach({ tabId }, '1.3');
  let targetInfo;
  try {
    ({ targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo'));
    await tabMarkers.mark(tabId);
  } catch (err) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await tabMarkers.unmark(tabId).catch(console.error);
    throw err;
  }
  attached.set(tabId, targetInfo);
  await persist();
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  await chrome.action.setBadgeText({ tabId, text: 'ON' });
  updateAttachedTitle(tabId);
  if (announce) send({ event: 'tabAttached', tabId, targetInfo });
  return targetInfo;
}

async function forget(tabId, reason) {
  if (!attached.delete(tabId)) return;
  send({ event: 'tabDetached', tabId, reason });
  await persist();
  await tabMarkers.unmark(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  updateTitle('Browser Relay: this tab is not shared. Click to attach it', tabId);
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
  await tabMarkers.restore([...attached.keys()]);
  for (const tabId of attached.keys()) {
    await chrome.action.setBadgeText({ tabId, text: 'ON' });
    updateAttachedTitle(tabId);
  }
  await persist();
}

function persist() {
  return chrome.storage.session.set({ tabs: Object.fromEntries(attached) });
}

function updateTitle(title, tabId) {
  chrome.action.setTitle(tabId === undefined ? { title } : { title, tabId }).catch(() => {});
}

function updateAttachedTitle(tabId) {
  const status = ws?.readyState === WebSocket.OPEN ? 'shared with local agents' : 'attached; relay offline';
  updateTitle(`Browser Relay: this tab is ${status}. Click to detach it`, tabId);
}
