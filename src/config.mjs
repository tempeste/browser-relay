// Shared settings for the relay, the MCP server and the CLI.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.BROWSER_RELAY_PORT || 19988);
export const CONFIG_DIR = process.env.BROWSER_RELAY_HOME || join(homedir(), '.config', 'browser-relay');
export const TOKEN_FILE = join(CONFIG_DIR, 'token');
export const LOG_FILE = join(CONFIG_DIR, 'relay.log');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// The token is the only secret: anything holding it can drive the attached tabs.
// It is created once and readable only by this user. Only the extensions you
// configure with it ever receive it.
export function loadToken() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(TOKEN_FILE, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  chmodSync(TOKEN_FILE, 0o600);
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

export function tokensMatch(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function relayUrl(path, port = PORT) {
  return `http://${HOST}:${port}${path}`;
}

// Optional remote access, off unless configured. The relay always listens on
// 127.0.0.1; `tailscale serve` forwards to it and names the caller.
//   publicHosts             Host headers accepted besides 127.0.0.1/localhost, e.g. "vm.tailnet.ts.net:19443"
//   allowedTailscaleLogins  Tailscale logins allowed through a public host
//   allowedExtensionIds     if set, the only extension IDs accepted on /extension
// Comma-separated BROWSER_RELAY_PUBLIC_HOSTS, BROWSER_RELAY_TAILSCALE_LOGINS and
// BROWSER_RELAY_EXTENSION_IDS replace the matching entry in config.json.
export function loadSettings() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${CONFIG_FILE}: ${err.message}`);
  }
  const list = (env, value = []) => {
    const items = process.env[env] !== undefined ? process.env[env].split(',') : value;
    if (!Array.isArray(items)) throw new Error(`${CONFIG_FILE}: expected a list of strings`);
    return [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  };
  const settings = {
    publicHosts: list('BROWSER_RELAY_PUBLIC_HOSTS', file.publicHosts),
    allowedTailscaleLogins: list('BROWSER_RELAY_TAILSCALE_LOGINS', file.allowedTailscaleLogins),
    allowedExtensionIds: list('BROWSER_RELAY_EXTENSION_IDS', file.allowedExtensionIds),
  };
  for (const host of settings.publicHosts) {
    if (!/^[a-z0-9.-]+:\d{1,5}$/.test(host)) throw new Error(`Public host "${host}" must look like name.tailnet.ts.net:19443`);
  }
  for (const id of settings.allowedExtensionIds) {
    if (!/^[a-p]{32}$/.test(id)) throw new Error(`"${id}" is not a Chrome extension ID`);
  }
  return settings;
}

export function saveSettings(settings) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(`${CONFIG_FILE}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
}
