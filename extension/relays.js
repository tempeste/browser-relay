// The relays this extension connects to, shared by the service worker and the
// options page. Each relay is { id, name, url, token }: its own address, its own
// token and its own connection.
const DEFAULT_PORT = 19988;
const LOCAL_RELAY_ID = 'local';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

// Plain ws:// only reaches this computer. A relay on another machine must use
// wss://, such as one published on your tailnet with `tailscale serve`.
function relayOrigin(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw new Error('Enter a URL such as ws://127.0.0.1:19988 or wss://machine.tailnet.ts.net:19443');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('The URL must start with ws:// or wss://');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter only the scheme, host and port');
  }
  if (url.protocol === 'ws:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error('A relay on another machine needs wss://; plain ws:// is only for this computer');
  }
  return url.origin;
}

function validateRelays(relays) {
  const urls = new Set();
  return relays.map((relay) => {
    const name = String(relay.name ?? '').trim();
    if (!name || name.length > 40 || /[\x00-\x1f\x7f·]/.test(name)) throw new Error('A relay name needs 1–40 printable characters, without "·"');
    const url = relayOrigin(relay.url);
    if (urls.has(url)) throw new Error(`${url} is already in the list`);
    urls.add(url);
    return { id: relay.id || crypto.randomUUID(), name, url, token: String(relay.token ?? '').trim() };
  });
}

// Version 0.2 stored one { token, port } for the relay on this computer. Fold it
// into the "This computer" entry, which also exists (without a token) on first run.
async function loadRelays() {
  const { relays, token, port } = await chrome.storage.local.get(['relays', 'token', 'port']);
  if (Array.isArray(relays) && token === undefined && port === undefined) return relays;
  const list = Array.isArray(relays) ? [...relays] : [];
  const i = list.findIndex((relay) => relay.id === LOCAL_RELAY_ID);
  const local = list[i] ?? { id: LOCAL_RELAY_ID, name: 'This computer', url: `ws://127.0.0.1:${DEFAULT_PORT}`, token: '' };
  if (port !== undefined) local.url = `ws://127.0.0.1:${Number(port) || DEFAULT_PORT}`;
  if (token !== undefined) local.token = String(token ?? '').trim();
  if (i === -1) list.unshift(local);
  else list[i] = local;
  await chrome.storage.local.set({ relays: list });
  // Only remove what was read: settings written meanwhile are folded in next time.
  const read = [token !== undefined && 'token', port !== undefined && 'port'].filter(Boolean);
  if (read.length) await chrome.storage.local.remove(read);
  return list;
}
