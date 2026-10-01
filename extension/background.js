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
const owners = new Map(); // tabId -> named relay session
const children = new Map(); // child CDP sessionId -> last attachment event
const tabQueues = new Map();
const forgetTasks = new Map();
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
  const event = { event: 'cdp', tabId: source.tabId, sessionId: source.sessionId, method, params };
  if (method === 'Target.attachedToTarget') {
    children.set(params.sessionId, event);
    persist().catch(console.error);
  } else if (method === 'Target.detachedFromTarget') {
    children.delete(params.sessionId);
    persist().catch(console.error);
  }
  send(event);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) forget(source.tabId, reason).catch(console.error);
});
chrome.tabs.onAttached.addListener((tabId) => {
  if (attached.has(tabId)) tabMarkers.mark(tabId, owners.get(tabId)).catch(console.error);
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
        send({ event: 'tabAttached', tabId, targetInfo, owner: owners.get(tabId) ?? null });
      }
      for (const event of children.values()) send(event);
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

// Serialize attachment and ownership changes. CDP requests stay concurrent so
// an awaiting page evaluation cannot prevent the user from detaching the tab.
function runTab(tabId, task) {
  const next = (tabQueues.get(tabId) ?? Promise.resolve()).then(task);
  const tail = next.catch(() => {});
  tabQueues.set(tabId, tail);
  tail.finally(() => { if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId); });
  return next;
}

async function handle({ id, method, params }) {
  try {
    await ready;
    let result;
    if (method === 'listTabs') result = await listTabs();
    else if (method === 'createTab') result = await createOwnedTab(params);
    else if (method === 'cdp') result = await tabCommand(method, params);
    else result = await runTab(params.tabId, () => tabCommand(method, params));
    send({ id, result: result ?? {} });
  } catch (err) {
    send({ id, error: String(err?.message ?? err) });
  }
}

async function listTabs() {
  const tabs = [];
  for (const tabId of attached.keys()) {
    try {
      const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      attached.set(tabId, targetInfo);
      tabs.push({ tabId, targetInfo, owner: owners.get(tabId) ?? null });
    } catch {
      await forget(tabId, 'no longer attached');
    }
  }
  return tabs;
}

async function createOwnedTab({ url, owner }) {
  if (!owner?.id || !owner.name) throw new Error('A named session is required');
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    return { tabId: tab.id, targetInfo: await attach(tab.id, { announce: false, owner }) };
  } catch (err) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw err;
  }
}

async function tabCommand(method, params) {
  const { tabId, owner } = params;
  if (!attached.has(tabId)) throw new Error(`tab ${tabId} is not attached`);
  if (method === 'claimTab') {
    if (owners.has(tabId)) throw new Error('Tab is already owned');
    await tabMarkers.mark(tabId, owner);
    if (!attached.has(tabId)) throw new Error('Tab detached during claim');
    owners.set(tabId, owner);
    await persist();
    updateAttachedTitle(tabId);
    return {};
  }
  if (!owner?.id || owners.get(tabId)?.id !== owner.id) throw new Error('Tab is not owned by this session');
  if (method === 'cdp') {
    const result = await chrome.debugger.sendCommand({ tabId, sessionId: params.sessionId }, params.method, params.params);
    if (params.method === 'Page.getFrameTree' && !params.sessionId) {
      result.frameTree = await completeFrameTree(tabId, result.frameTree);
    }
    return result;
  }
  if (method === 'releaseTab') {
    await chrome.debugger.detach({ tabId });
    await forget(tabId, 'released by session');
  } else if (method === 'closeTab') {
    await chrome.tabs.remove(tabId);
  } else if (method === 'activateTab') {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    throw new Error(`unknown method ${method}`);
  }
  return {};
}

// A root renderer's frame tree omits the documents in other renderer processes.
// Include their current trees so a reconnect sees existing iframe URLs immediately.
async function completeFrameTree(tabId, root) {
  const snapshots = new Map();
  for (const event of children.values()) {
    if (event.tabId !== tabId || event.params.targetInfo.type !== 'iframe') continue;
    try {
      const { frameTree } = await chrome.debugger.sendCommand(
        { tabId, sessionId: event.params.sessionId }, 'Page.getFrameTree',
      );
      frameTree.frame.parentId ??= event.params.targetInfo.parentFrameId;
      snapshots.set(frameTree.frame.id, frameTree);
    } catch {
      // A frame may navigate or disappear during this snapshot.
    }
  }
  const stitch = (tree) => {
    const full = snapshots.get(tree.frame.id) ?? tree;
    const nested = new Map([...(tree.childFrames ?? []), ...(full.childFrames ?? [])].map((child) => [child.frame.id, child]));
    for (const child of snapshots.values()) {
      if (child.frame.parentId === full.frame.id) nested.set(child.frame.id, child);
    }
    return { ...full, ...(nested.size ? { childFrames: [...nested.values()].map(stitch) } : {}) };
  };
  return stitch(root);
}

async function toggle(tabId) {
  await ready;
  return runTab(tabId, async () => {
    await forgetTasks.get(tabId);
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
  });
}

async function attach(tabId, { announce = true, owner = null } = {}) {
  await chrome.debugger.attach({ tabId }, '1.3');
  let targetInfo;
  try {
    ({ targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo'));
    await tabMarkers.mark(tabId, owner);
  } catch (err) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await tabMarkers.unmark(tabId).catch(console.error);
    throw err;
  }
  attached.set(tabId, targetInfo);
  if (owner) owners.set(tabId, owner);
  await persist();
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  await chrome.action.setBadgeText({ tabId, text: 'ON' });
  updateAttachedTitle(tabId);
  if (announce) send({ event: 'tabAttached', tabId, targetInfo, owner: owners.get(tabId) ?? null });
  return targetInfo;
}

function forget(tabId, reason) {
  if (forgetTasks.has(tabId)) return forgetTasks.get(tabId);
  if (!attached.delete(tabId)) return Promise.resolve();
  owners.delete(tabId);
  for (const [id, event] of children) if (event.tabId === tabId) children.delete(id);
  send({ event: 'tabDetached', tabId, reason });
  const task = (async () => {
    await persist();
    await tabMarkers.unmark(tabId);
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    updateTitle('Browser Relay: this tab is not shared. Click to attach it', tabId);
  })();
  forgetTasks.set(tabId, task);
  task.finally(() => forgetTasks.delete(tabId)).catch(() => {});
  return task;
}

// The worker can be stopped and restarted while debugger sessions stay attached,
// so the attached-tab list lives in session storage and is re-checked on wake.
async function restoreAttached() {
  const { tabs = {}, tabOwners = {}, tabChildren = [] } = await chrome.storage.session.get(['tabs', 'tabOwners', 'tabChildren']);
  for (const [key, targetInfo] of Object.entries(tabs)) {
    const tabId = Number(key);
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      attached.set(tabId, targetInfo);
      if (tabOwners[key]) owners.set(tabId, tabOwners[key]);
    } catch {
      // No longer attached (tab closed, browser restarted, or the user pressed Cancel).
    }
  }
  for (const event of tabChildren) {
    if (!attached.has(event.tabId)) continue;
    try {
      const { targetInfo } = await chrome.debugger.sendCommand({ tabId: event.tabId, sessionId: event.params.sessionId }, 'Target.getTargetInfo');
      event.params.targetInfo = { ...event.params.targetInfo, ...targetInfo };
      children.set(event.params.sessionId, event);
    } catch {
      // Child frames/workers can disappear while the service worker is stopped.
    }
  }
  await tabMarkers.restore([...attached.keys()], owners);
  for (const tabId of attached.keys()) {
    await chrome.action.setBadgeText({ tabId, text: 'ON' });
    updateAttachedTitle(tabId);
  }
  await persist();
}

function persist() {
  return chrome.storage.session.set({
    tabs: Object.fromEntries(attached), tabOwners: Object.fromEntries(owners), tabChildren: [...children.values()],
  });
}

function updateTitle(title, tabId) {
  chrome.action.setTitle(tabId === undefined ? { title } : { title, tabId }).catch(() => {});
}

function updateAttachedTitle(tabId) {
  const owner = owners.get(tabId);
  const status = owner ? `owned by ${owner.name}` : 'available to claim';
  const offline = ws?.readyState === WebSocket.OPEN ? '' : '; relay offline';
  updateTitle(`Browser Relay: this tab is ${status}${offline}. Click to detach it`, tabId);
}
