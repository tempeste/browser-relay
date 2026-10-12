// `browser-relay remote` publishes this relay's /extension endpoint on the tailnet
// with `tailscale serve`, so Chrome on another machine you own can connect to it.
// `browser-relay service` keeps the relay running without an MCP client (Linux).
// Neither ever prints the token.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, CONFIG_FILE, HOST, PORT, loadSettings, loadToken, relayUrl, saveSettings } from './config.mjs';

const DEFAULT_HTTPS_PORT = 19443;
const CLI = fileURLToPath(new URL('../bin/browser-relay', import.meta.url));
const UNIT_NAME = 'browser-relay.service';
const UNIT_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', UNIT_NAME);
const target = `http://${HOST}:${PORT}`;

function option(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return [];
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return [args[i + 1], ...option(args.slice(i + 2), name)];
}

function tailscale(...args) {
  try {
    return execFileSync('tailscale', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`tailscale ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`);
  }
}

function tailnetName() {
  const self = JSON.parse(tailscale('status', '--json')).Self;
  const name = self?.DNSName?.replace(/\.$/, '');
  if (!name) throw new Error('This machine has no MagicDNS name. Enable MagicDNS and HTTPS certificates for the tailnet.');
  return { name: name.toLowerCase(), host: self.HostName };
}

// What `tailscale serve` currently does with one HTTPS port on this machine.
function servePort(publicHost) {
  const status = JSON.parse(tailscale('serve', 'status', '--json') || '{}');
  const handlers = status.Web?.[publicHost]?.Handlers ?? null;
  return {
    funnel: Boolean(status.AllowFunnel?.[publicHost]),
    handlers,
    ours: Boolean(handlers) && Object.keys(handlers).length === 1 && handlers['/']?.Proxy === target,
  };
}

const serveCommand = (httpsPort) => ['serve', '--bg', `--https=${httpsPort}`, target];
const serveOffCommand = (httpsPort) => ['serve', `--https=${httpsPort}`, 'off'];
const shell = (args) => `tailscale ${args.join(' ')}`;

export async function remoteCommand([action = 'status', ...args]) {
  const settings = loadSettings();
  const { name, host } = tailnetName();
  const apply = args.includes('--apply');

  if (action === 'enable') {
    const logins = option(args, '--login').map((l) => l.toLowerCase());
    const extensionIds = option(args, '--extension-id').map((id) => id.toLowerCase());
    const httpsPort = Number(option(args, '--https-port')[0] ?? DEFAULT_HTTPS_PORT);
    if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) throw new Error('--https-port must be a port number');
    if (!logins.length && !settings.allowedTailscaleLogins.length) {
      throw new Error('Name at least one Tailscale login allowed to connect, e.g. --login you@example.com (see `tailscale status --json`)');
    }
    const publicHost = `${name}:${httpsPort}`;
    const serve = servePort(publicHost);
    if (serve.funnel) throw new Error(`Funnel is on for ${publicHost}. Pick another --https-port; the relay must never be public.`);
    if (serve.handlers && !serve.ours) throw new Error(`tailscale serve already uses ${publicHost} for something else. Pick another --https-port.`);
    saveSettings({
      ...settings,
      publicHosts: [...new Set([...settings.publicHosts.filter((h) => !h.startsWith(`${name}:`)), publicHost])],
      allowedTailscaleLogins: [...new Set([...settings.allowedTailscaleLogins, ...logins])],
      allowedExtensionIds: [...new Set([...settings.allowedExtensionIds, ...extensionIds])],
    });
    console.log(`Saved ${CONFIG_FILE}.`);
    if (apply && !serve.ours) {
      tailscale(...serveCommand(httpsPort));
      if (servePort(publicHost).funnel) throw new Error(`Funnel turned on for ${publicHost}; run: ${shell(serveOffCommand(httpsPort))}`);
      console.log(`Applied: ${shell(serveCommand(httpsPort))}`);
    }
    console.log(`Restart the relay so it reads the new settings: ${restartHint()}\n`);
    return printStatus(loadSettings(), name, host);
  }

  if (action === 'disable') {
    const mine = settings.publicHosts.filter((h) => h.startsWith(`${name}:`));
    saveSettings({ ...settings, publicHosts: settings.publicHosts.filter((h) => !mine.includes(h)) });
    console.log(`Removed ${mine.join(', ') || 'no public hosts'} from ${CONFIG_FILE}. Restart the relay: ${restartHint()}`);
    for (const publicHost of mine) {
      const httpsPort = publicHost.split(':')[1];
      if (!servePort(publicHost).ours) continue;
      if (apply) {
        tailscale(...serveOffCommand(httpsPort));
        console.log(`Applied: ${shell(serveOffCommand(httpsPort))}`);
      } else {
        console.log(`Remove the tailnet proxy with: ${shell(serveOffCommand(httpsPort))}`);
      }
    }
    return;
  }

  if (action !== 'status') throw new Error('Usage: browser-relay remote [status | enable --login <login> [--https-port 19443] [--extension-id <id>] [--apply] | disable [--apply]]');
  printStatus(settings, name, host);
}

function printStatus(settings, name, host) {
  const mine = settings.publicHosts.filter((h) => h.startsWith(`${name}:`));
  if (!mine.length) {
    console.log(`Remote access is off. Enable it with:\n  browser-relay remote enable --login <your Tailscale login> --apply`);
    return;
  }
  console.log(`Relay:            ${target} (always loopback only)`);
  console.log(`Tailscale logins: ${settings.allowedTailscaleLogins.join(', ') || '(none, so nobody can connect)'}`);
  if (settings.allowedExtensionIds.length) console.log(`Extension IDs:    ${settings.allowedExtensionIds.join(', ')}`);
  for (const publicHost of mine) {
    const httpsPort = publicHost.split(':')[1];
    const serve = servePort(publicHost);
    const state = serve.funnel ? 'FUNNEL IS ON: turn it off now' : serve.ours ? 'tailnet only' : 'not set up';
    console.log(`\nhttps://${publicHost} -> ${target}: ${state}`);
    if (!serve.ours) console.log(`  set up:    ${shell(serveCommand(httpsPort))}`);
    console.log(`  tear down: ${shell(serveOffCommand(httpsPort))} && browser-relay remote disable`);
    console.log(`\nIn Chrome on the other machine, open Browser Relay's options and add a relay:`);
    console.log(`  Name:  ${host}`);
    console.log(`  URL:   wss://${publicHost}`);
    console.log(`  Token: this machine's token. Copy it without displaying it, for example from the other machine:`);
    console.log(`         ssh ${process.env.USER}@${name} ${process.execPath} ${CLI} token | pbcopy`);
  }
}

function restartHint() {
  return existsSync(UNIT_FILE) ? `systemctl --user restart ${UNIT_NAME}` : 'browser-relay stop (the next MCP call starts it again)';
}

function unit() {
  const env = [`BROWSER_RELAY_PORT=${PORT}`, ...(process.env.BROWSER_RELAY_HOME ? [`BROWSER_RELAY_HOME=${CONFIG_DIR}`] : [])];
  return `[Unit]
Description=Browser Relay on ${HOST}:${PORT}
Documentation=https://github.com/tempeste/browser-relay

[Service]
ExecStart=${process.execPath} ${CLI} serve
${env.map((e) => `Environment=${e}`).join('\n')}
# \`browser-relay stop\` exits cleanly, so this also makes it a restart.
Restart=always
RestartSec=2
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

const systemctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });

export async function serviceCommand([action = 'print']) {
  if (action === 'print') return process.stdout.write(unit());
  if (process.platform !== 'linux') throw new Error('browser-relay service manages a systemd --user unit, so it only runs on Linux');
  if (action === 'install') {
    mkdirSync(join(UNIT_FILE, '..'), { recursive: true });
    writeFileSync(UNIT_FILE, unit());
    systemctl('daemon-reload');
    // Hand the port over from a relay an MCP server started in the background.
    await fetch(relayUrl('/shutdown'), { method: 'POST', headers: { authorization: `Bearer ${loadToken()}` }, signal: AbortSignal.timeout(1000) })
      .then(() => new Promise((r) => setTimeout(r, 500)), () => {});
    systemctl('enable', '--now', UNIT_NAME);
    console.log(`Installed ${UNIT_FILE}. Logs: journalctl --user -u ${UNIT_NAME}`);
    try {
      const linger = execFileSync('loginctl', ['show-user', process.env.USER, '-p', 'Linger'], { encoding: 'utf8' });
      if (!linger.includes('yes')) console.log(`To keep it running while you are logged out: sudo loginctl enable-linger ${process.env.USER}`);
    } catch {
      // loginctl is optional; the unit still runs while you are logged in.
    }
  } else if (action === 'uninstall') {
    if (existsSync(UNIT_FILE)) systemctl('disable', '--now', UNIT_NAME);
    rmSync(UNIT_FILE, { force: true });
    systemctl('daemon-reload');
    console.log(`Removed ${UNIT_FILE}.`);
  } else {
    throw new Error('Usage: browser-relay service [print | install | uninstall]');
  }
}
