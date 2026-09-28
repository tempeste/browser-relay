// Minimal MCP server (stdio, newline-delimited JSON-RPC) with two tools:
//   execute - run a Playwright snippet against the attached tabs
//   reset   - drop the connection and the `state` object
// It starts the relay in the background if nothing is listening yet.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { chromium } from 'playwright-core';
import { HOST, LOG_FILE, PORT, loadToken, relayUrl } from './config.mjs';

const VERSION = '0.1.0';
const OUTPUT_LIMIT = 20_000;
const EXTENSION_WAIT_MS = 35_000; // one extension reconnect alarm period, plus slack
const CLI = fileURLToPath(new URL('../bin/browser-relay', import.meta.url));
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const token = loadToken();
let browser = null;
let currentPage = null;
let state = {};

const EXECUTE_DESCRIPTION = `Run JavaScript (Playwright) against Chrome tabs the user attached with the Browser Relay extension.
In scope: page (current page or null), context, browser, state (persists between calls), console (captured), require, setPage(p).
- page is the last page you selected with setPage, else the most recently attached tab.
- If page is null, ask the user to click the Browser Relay toolbar button on the tab, or open one with: const p = await context.newPage(); setPage(p);
- Pages opened with context.newPage() open as background tabs in the user's real, logged-in Chrome.
- Return a value to see it. Returning a Buffer from page.screenshot() shows the image.
- Prefer short snippets; call execute several times rather than writing one long script.`;

const TOOLS = [
  {
    name: 'execute',
    description: EXECUTE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Async function body. Use await; return a value to see it.' },
        timeout: { type: 'number', description: 'Milliseconds before giving up (default 30000).' },
      },
      required: ['code'],
    },
  },
  {
    name: 'reset',
    description: 'Disconnect from the relay and clear state. Use after connection errors.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function relayHealth() {
  try {
    const res = await fetch(relayUrl('/health'), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function ensureRelay() {
  if (!(await relayHealth())) {
    const out = openSync(LOG_FILE, 'a');
    spawn(process.execPath, [CLI, 'serve'], { detached: true, stdio: ['ignore', out, out] }).unref();
    if (!(await waitFor(relayHealth, 5000))) throw new Error(`The relay did not start. See ${LOG_FILE}`);
  }
  const connected = await waitFor(async () => (await relayHealth())?.extension, EXTENSION_WAIT_MS);
  if (!connected) {
    throw new Error(
      'The relay is running but the Browser Relay extension is not connected. Make sure Chrome is open, ' +
        'the extension is loaded, and its options page has the token from `browser-relay token`.',
    );
  }
}

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  await ensureRelay();
  browser = await chromium.connectOverCDP(`ws://${HOST}:${PORT}/cdp`, {
    headers: { authorization: `Bearer ${token}` },
    timeout: 15_000,
  });
  browser.on('disconnected', () => {
    browser = null;
    currentPage = null;
  });
  return browser;
}

function pickPage(context) {
  if (currentPage && !currentPage.isClosed()) return currentPage;
  return context.pages().at(-1) ?? null;
}

function capturingConsole(lines) {
  const record = (level) => (...args) =>
    lines.push((level ? `[${level}] ` : '') + args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' '));
  return { log: record(''), info: record(''), warn: record('warn'), error: record('error'), debug: record('debug') };
}

function imageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return null;
}

function truncate(text) {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (${text.length - OUTPUT_LIMIT} more characters)` : text;
}

async function execute({ code, timeout = 30_000 }) {
  const b = await getBrowser();
  const context = b.contexts()[0];
  const lines = [];
  const fn = new AsyncFunction('page', 'context', 'browser', 'state', 'console', 'require', 'setPage', code);
  let timer;
  const result = await Promise.race([
    fn(pickPage(context), context, b, state, capturingConsole(lines), require, (p) => (currentPage = p)),
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout))),
  ]).finally(() => clearTimeout(timer));

  const content = [];
  if (Buffer.isBuffer(result) && imageMime(result)) {
    content.push({ type: 'image', data: result.toString('base64'), mimeType: imageMime(result) });
  } else if (result !== undefined) {
    lines.push(`Return value: ${typeof result === 'string' ? result : inspect(result, { depth: 6 })}`);
  }
  const text = lines.join('\n');
  if (text || content.length === 0) content.unshift({ type: 'text', text: truncate(text || '(no output)') });
  return content;
}

async function reset() {
  await browser?.close().catch(() => {});
  browser = null;
  currentPage = null;
  state = {};
  return [{ type: 'text', text: 'Connection and state cleared.' }];
}

async function handleRequest({ method, params = {} }) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'browser-relay', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const run = { execute, reset }[params.name];
      if (!run) throw Object.assign(new Error(`Unknown tool ${params.name}`), { code: -32602 });
      try {
        return { content: await run(params.arguments ?? {}) };
      } catch (err) {
        return { content: [{ type: 'text', text: truncate(err.stack || String(err)) }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

export function startMcpServer() {
  const reply = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return reply({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (msg.id === undefined) return; // notifications need no answer
    try {
      reply({ id: msg.id, result: await handleRequest(msg) });
    } catch (err) {
      reply({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
