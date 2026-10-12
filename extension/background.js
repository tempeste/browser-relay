// Browser Relay service worker.
//
// Clicking the toolbar button attaches chrome.debugger to that tab and offers it to
// the relays listed in the options: the relay on this computer (ws://127.0.0.1) and
// any relays on other machines you own (wss://). Each relay has its own token and
// WebSocket. A tab belongs to at most one relay session: the first to claim it, or
// the one that opened it. Only that relay sees its CDP events or can command it.
// Those relays are the only network endpoints this file ever talks to.
// Controlled tabs have an orange Browser Relay tab group; Chrome's browser-wide
// debugging bar also offers Cancel to detach all tabs.

importScripts('relays.js', 'tab-markers.js');

const PING_MS = 20_000;
const RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

const conns = new Map(); // relay ID -> { relay, ws, retryMs, retryTimer, status }
const attached = new Map(); // tabId -> targetInfo
const owners = new Map(); // tabId -> { relay, id, name }: a named session on one relay
const children = new Map(); // child CDP sessionId -> last attachment event
const tabQueues = new Map();
const forgetTasks = new Map();
const tabMarkers = new RelayTabMarkers((relayId) => conns.get(relayId)?.relay.name ?? 'removed relay');
let relaysQueue = Promise.resolve();
const ready = syncRelays().then(restoreAttached);

// Listeners must be registered synchronously so events wake the worker.
chrome.action.onClicked.addListener((tab) => toggle(tab.id));
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
// Wakes the worker every 30s so it reconnects after a relay restart.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.storage.onChanged.addListener((changes, area) => {
  const legacy = changes.token?.newValue !== undefined || changes.port?.newValue !== undefined;
  if (area !== 'local' || (!changes.relays && !legacy)) return;
  syncRelays().then(() => connect()).catch(console.error);
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
  const owner = owners.get(source.tabId);
  if (owner) sendTo(owner.relay, event);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) forget(source.tabId, reason).catch(console.error);
});
chrome.tabs.onAttached.addListener((tabId) => {
  if (attached.has(tabId)) tabMarkers.mark(tabId, owners.get(tabId)).catch(console.error);
});
chrome.tabGroups.onRemoved.addListener((group) => tabMarkers.groupRemoved(group.id).catch(console.error));

connect();

// Apply the stored relay list: open new relays, reconnect changed ones and drop
// removed ones. Tabs owned through a removed relay are released.
function syncRelays() {
  const next = relaysQueue.then(async () => {
    const relays = await loadRelays();
    for (const relay of relays) {
      const conn = conns.get(relay.id);
      if (!conn) {
        conns.set(relay.id, { relay, ws: null, retryMs: 0, retryTimer: null, status: 'offline' });
        continue;
      }
      const moved = conn.relay.url !== relay.url || conn.relay.token !== relay.token;
      const renamed = conn.relay.name !== relay.name;
      conn.relay = relay;
      if (moved) disconnect(conn);
      if (renamed) {
        for (const [tabId, owner] of owners) if (owner.relay === relay.id) tabMarkers.mark(tabId, owner).catch(console.error);
      }
    }
    for (const [id, conn] of conns) {
      if (relays.some((relay) => relay.id === id)) continue;
      conns.delete(id);
      disconnect(conn);
      for (const [tabId, owner] of owners) if (owner.relay === id) release(tabId, 'relay removed').catch(console.error);
    }
    publishStatus();
  });
  relaysQueue = next.catch(console.error);
  return next;
}

function disconnect(conn) {
  clearTimeout(conn.retryTimer);
  conn.retryMs = 0;
  const old = conn.ws;
  conn.ws = null;
  old?.close();
  conn.status = 'offline';
}

// Without an ID, connects every relay. Each relay keeps its own socket and backoff.
async function connect(relayId) {
  await ready;
  if (relayId === undefined) return Promise.all([...conns.keys()].map(connect));
  const conn = conns.get(relayId);
  if (!conn || (conn.ws && conn.ws.readyState <= WebSocket.OPEN)) return;
  clearTimeout(conn.retryTimer);
  if (!conn.relay.token) return setStatus(conn, 'needs a token');
  let sock;
  try {
    sock = new WebSocket(`${conn.relay.url}/extension?token=${encodeURIComponent(conn.relay.token)}`);
  } catch (err) {
    // A bad stored URL must not block the other relays or later alarms.
    setStatus(conn, `failed (${err.message})`);
    return retry(conn);
  }
  conn.ws = sock;
  setStatus(conn, 'connecting');
  let pingTimer = null;
  sock.onopen = () => {
    if (conn.ws !== sock) return;
    conn.retryMs = 0;
    setStatus(conn, 'connected');
    for (const [tabId, targetInfo] of attached) {
      updateAttachedTitle(tabId);
      if (visibleTo(relayId, tabId)) sendTo(relayId, { event: 'tabAttached', tabId, targetInfo, owner: sessionOf(owners.get(tabId)) });
    }
    for (const event of children.values()) if (owners.get(event.tabId)?.relay === relayId) sendTo(relayId, event);
    // Traffic on this socket keeps the service worker alive (Chrome 116+).
    pingTimer = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ event: 'ping' }));
    }, PING_MS);
  };
  sock.onmessage = (e) => handle(relayId, sock, JSON.parse(e.data));
  sock.onerror = () => {};
  sock.onclose = () => {
    clearInterval(pingTimer);
    if (conn.ws !== sock) return;
    conn.ws = null;
    setStatus(conn, 'offline');
    for (const tabId of attached.keys()) updateAttachedTitle(tabId);
    retry(conn);
  };
}

function retry(conn) {
  if (conns.get(conn.relay.id) !== conn) return;
  conn.retryMs = Math.min(conn.retryMs ? conn.retryMs * 2 : RETRY_MS, MAX_RETRY_MS);
  clearTimeout(conn.retryTimer);
  conn.retryTimer = setTimeout(() => connect(conn.relay.id), conn.retryMs);
}

const isOpen = (relayId) => conns.get(relayId)?.ws?.readyState === WebSocket.OPEN;
// Unclaimed tabs are offered to every relay; claimed tabs only to their own.
const visibleTo = (relayId, tabId) => !owners.has(tabId) || owners.get(tabId).relay === relayId;
// Relays know their own sessions by { id, name }; the relay ID stays in the extension.
const sessionOf = (owner) => owner ? { id: owner.id, name: owner.name } : null;

function sendTo(relayId, msg) {
  const ws = conns.get(relayId)?.ws;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function announce(msg, owner) {
  for (const relayId of conns.keys()) if (!owner || owner.relay === relayId) sendTo(relayId, msg);
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

// Answers go back on the socket the request came from, so a reconnect cannot
// deliver one relay's answer to another connection.
async function handle(relayId, sock, { id, method, params }) {
  const reply = (msg) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(msg));
  try {
    await ready;
    let result;
    if (method === 'listTabs') result = await listTabs(relayId);
    else if (method === 'createTab') result = await createOwnedTab(relayId, params);
    else if (method === 'cdp') result = await tabCommand(relayId, method, params);
    else result = await runTab(params.tabId, () => tabCommand(relayId, method, params));
    reply({ id, result: result ?? {} });
  } catch (err) {
    reply({ id, error: String(err?.message ?? err) });
  }
}

async function listTabs(relayId) {
  const tabs = [];
  for (const tabId of attached.keys()) {
    try {
      const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      attached.set(tabId, targetInfo);
      if (visibleTo(relayId, tabId)) tabs.push({ tabId, targetInfo, owner: sessionOf(owners.get(tabId)) });
    } catch {
      await forget(tabId, 'no longer attached');
    }
  }
  return tabs;
}

async function createOwnedTab(relayId, { url, owner }) {
  if (!owner?.id || !owner.name) throw new Error('A named session is required');
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    return { tabId: tab.id, targetInfo: await attach(tab.id, { announce: false, owner: { relay: relayId, id: owner.id, name: owner.name } }) };
  } catch (err) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw err;
  }
}

async function tabCommand(relayId, method, params) {
  const { tabId, owner } = params;
  if (!attached.has(tabId)) throw new Error(`tab ${tabId} is not attached`);
  if (method === 'claimTab') {
    if (!owner?.id || !owner.name) throw new Error('A named session is required');
    // Claims are serialized per tab, so the first relay to claim wins.
    if (owners.has(tabId)) throw new Error('Tab is already owned');
    const claimed = { relay: relayId, id: owner.id, name: owner.name };
    await tabMarkers.mark(tabId, claimed);
    if (!attached.has(tabId)) throw new Error('Tab detached during claim');
    owners.set(tabId, claimed);
    await persist();
    updateAttachedTitle(tabId);
    // The other relays listed this tab as available. It is no longer theirs to see.
    for (const id of conns.keys()) if (id !== relayId) sendTo(id, { event: 'tabDetached', tabId, reason: 'claimed through another relay' });
    return {};
  }
  const current = owners.get(tabId);
  if (!owner?.id || current?.relay !== relayId || current.id !== owner.id) throw new Error('Tab is not owned by this session');
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
    if (![...conns.values()].some((conn) => conn.relay.token)) return chrome.runtime.openOptionsPage();
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

function release(tabId, reason) {
  return runTab(tabId, async () => {
    if (!attached.has(tabId)) return;
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await forget(tabId, reason);
  });
}

async function attach(tabId, { announce: announceTab = true, owner = null } = {}) {
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
  if (announceTab) announce({ event: 'tabAttached', tabId, targetInfo, owner: sessionOf(owner) }, owner);
  return targetInfo;
}

function forget(tabId, reason) {
  if (forgetTasks.has(tabId)) return forgetTasks.get(tabId);
  if (!attached.delete(tabId)) return Promise.resolve();
  const owner = owners.get(tabId);
  owners.delete(tabId);
  for (const [id, event] of children) if (event.tabId === tabId) children.delete(id);
  announce({ event: 'tabDetached', tabId, reason }, owner);
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
    const owner = tabOwners[key];
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      if (owner && !conns.has(owner.relay)) {
        // Its relay was removed while the worker was stopped.
        await chrome.debugger.detach({ tabId }).catch(() => {});
        continue;
      }
      attached.set(tabId, targetInfo);
      if (owner) owners.set(tabId, owner);
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

function setStatus(conn, status) {
  conn.status = status;
  publishStatus();
}

// The options page shows each relay's status from session storage.
function publishStatus() {
  const relayStatus = Object.fromEntries([...conns].map(([id, conn]) => [id, conn.status]));
  chrome.storage.session.set({ relayStatus }).catch(() => {});
  const open = [...conns.keys()].filter(isOpen).length;
  if (![...conns.values()].some((conn) => conn.relay.token)) {
    updateTitle('Browser Relay: add a relay token in the extension options');
  } else {
    updateTitle(`Browser Relay: connected to ${open} of ${conns.size} relay${conns.size === 1 ? '' : 's'}. Click to attach or detach this tab`);
  }
}

function updateTitle(title, tabId) {
  chrome.action.setTitle(tabId === undefined ? { title } : { title, tabId }).catch(() => {});
}

function updateAttachedTitle(tabId) {
  const owner = owners.get(tabId);
  const status = owner ? `owned by ${owner.name} on ${conns.get(owner.relay)?.relay.name ?? 'a removed relay'}` : 'available to claim';
  const online = owner ? isOpen(owner.relay) : [...conns.keys()].some(isOpen);
  const offline = online ? '' : owner ? '; its relay is offline' : '; no relay connected';
  updateTitle(`Browser Relay: this tab is ${status}${offline}. Click to detach it`, tabId);
}
