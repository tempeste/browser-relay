// MCP tools use explicit named sessions, including when one server serves several tasks.
// It starts the relay in the background if nothing is listening yet.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { chromium } from 'playwright-core';
import { HOST, LOG_FILE, PORT, loadToken, relayUrl } from './config.mjs';

const VERSION = '0.2.0';
const OUTPUT_LIMIT = 20_000;
const EXTENSION_WAIT_MS = 35_000; // one extension reconnect alarm period, plus slack
const CLI = fileURLToPath(new URL('../bin/browser-relay', import.meta.url));
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const token = loadToken();
const localSessions = new Map();

function localSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required; create a named session first');
  if (!localSessions.has(sessionId)) localSessions.set(sessionId, { browser: null, currentPage: null, state: {}, queue: Promise.resolve() });
  return localSessions.get(sessionId);
}

function inSession(sessionId, task) {
  const session = localSession(sessionId);
  const next = session.queue.then(() => task(session));
  session.queue = next.catch(() => {});
  return next;
}

const EXECUTE_DESCRIPTION = `Run JavaScript (Playwright) against Chrome tabs owned by the specified named Browser Relay session.
In scope: page (current page or null), context, browser, state (persists between calls), console (captured), require, setPage(p).
- sessionId is required. Create a session with the session tool, then explicitly claim a manually attached tab or open a new one.
- page is the last page selected with setPage, else the most recent tab owned by this session. Other sessions and unclaimed tabs are invisible.
- If page is null, claim an attached tab with the session tool, or open one with: const p = await context.newPage(); setPage(p);
- Pages opened with context.newPage() open as background tabs in the user's real, logged-in Chrome.
- Return a value to see it. Returning a Buffer from page.screenshot() shows the image.
- A timeout drops this session's connection. Call reset before executing again.
- Prefer short snippets; call execute several times rather than writing one long script.`;

const TOOLS = [
  {
    name: 'session',
    description: 'Create a named session; list sessions and unclaimed/own tabs; explicitly claim an attached tab; release a tab; or close a session. Release/close detach tabs and restore their original grouping without closing the tabs. Disconnects preserve ownership. Use a separate session for each task and pass its ID to execute/reset. List without an ID shows unclaimed tabs only. Resume a known ID to reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'claim', 'release', 'close'] },
        name: { type: 'string', description: 'Short readable group label, required for create.' },
        sessionId: { type: 'string', description: 'Required except for create and unclaimed-tab listing.' },
        tabId: { type: 'integer', description: 'Required for claim/release. Get it from list.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'execute',
    description: EXECUTE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'ID returned by session create.' },
        code: { type: 'string', description: 'Async function body. Use await; return a value to see it.' },
        timeout: { type: 'number', description: 'Milliseconds before giving up (default 30000).' },
      },
      required: ['sessionId', 'code'],
    },
  },
  {
    name: 'reset',
    description: 'Disconnect this session and clear its local state. Owned tabs remain reserved for reconnect. Use session close to release them.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
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

async function getBrowser(session, sessionId) {
  if (session.browser?.isConnected()) return session.browser;
  await ensureRelay();
  const browser = await chromium.connectOverCDP(`ws://${HOST}:${PORT}/cdp`, {
    headers: { authorization: `Bearer ${token}`, 'x-browser-relay-session': sessionId },
    timeout: 15_000,
  });
  session.browser = browser;
  browser.on('disconnected', () => {
    if (session.browser === browser) {
      session.browser = null;
      session.currentPage = null;
    }
  });
  return browser;
}

function pickPage(session, context) {
  if (session.currentPage && !session.currentPage.isClosed()) return session.currentPage;
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

async function execute({ sessionId, code, timeout = 30_000 }) {
  if (typeof code !== 'string') throw new Error('code must be a string');
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300_000) throw new Error('timeout must be 1–300000ms');
  return inSession(sessionId, async (session) => {
    if (session.timedOut) throw new Error('Previous execution timed out; reset this session before retrying');
    const b = await getBrowser(session, sessionId);
    const context = b.contexts()[0];
    const lines = [];
    const fn = new AsyncFunction('page', 'context', 'browser', 'state', 'console', 'require', 'setPage', code);
    let timer;
    let active = true;
    const result = await Promise.race([
      fn(pickPage(session, context), context, b, session.state, capturingConsole(lines), require, (p) => {
        if (!active) throw new Error('Execution is no longer active');
        if (p !== null && (!context.pages().includes(p) || p.isClosed())) throw new Error('setPage requires a live page owned by this session');
        session.currentPage = p;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          session.timedOut = true;
          b.close().catch(() => {});
          reject(new Error(`Timed out after ${timeout}ms; connection dropped. Reset this session before retrying`));
        }, timeout);
      }),
    ]).finally(() => { active = false; clearTimeout(timer); });

    const content = [];
    if (Buffer.isBuffer(result) && imageMime(result)) {
      content.push({ type: 'image', data: result.toString('base64'), mimeType: imageMime(result) });
    } else if (result !== undefined) {
      lines.push(`Return value: ${typeof result === 'string' ? result : inspect(result, { depth: 6 })}`);
    }
    const text = lines.join('\n');
    if (text || content.length === 0) content.unshift({ type: 'text', text: truncate(text || '(no output)') });
    return content;
  });
}

async function reset({ sessionId }) {
  return inSession(sessionId, async (session) => {
    await session.browser?.close().catch(() => {});
    session.browser = null;
    session.currentPage = null;
    session.state = {};
    session.timedOut = false;
    return [{ type: 'text', text: 'Connection and state cleared; tab ownership preserved.' }];
  });
}

async function session(args) {
  await ensureRelay();
  const run = async () => {
    const res = await fetch(relayUrl('/sessions'), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(60_000),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    if (['claim', 'release', 'close'].includes(args.action)) {
      const local = localSession(args.sessionId);
      await local.browser?.close().catch(() => {});
      local.browser = null;
      local.currentPage = null;
      if (args.action === 'close') local.state = {};
    }
    return [{ type: 'text', text: JSON.stringify(result) }];
  };
  return args.sessionId ? inSession(args.sessionId, run) : run();
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
      const run = { session, execute, reset }[params.name];
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
