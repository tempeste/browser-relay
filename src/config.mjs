// Shared settings for the relay, the MCP server and the CLI.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.BROWSER_RELAY_PORT || 19988);
export const CONFIG_DIR = process.env.BROWSER_RELAY_HOME || join(homedir(), '.config', 'browser-relay');
export const TOKEN_FILE = join(CONFIG_DIR, 'token');
export const LOG_FILE = join(CONFIG_DIR, 'relay.log');

// The token is the only secret: anything holding it can drive the attached tabs.
// It is created once, readable only by this user, and never leaves the machine.
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
