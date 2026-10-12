# browser-relay

Lets agents drive tabs in your real, logged-in Chrome through a relay and an unpacked extension. Each task uses a named session with its own tabs and a visible Chrome tab group. Agents usually run on the same computer as Chrome; agents on your other machines can use the same Chrome through their own relay (see [Using it from several machines](#using-it-from-several-machines)).

```
agent ── MCP (stdio) ── browser-relay mcp ──┐
                                            │ ws://127.0.0.1:19988/cdp   (token in header)
                                     browser-relay serve (relay)
                                            │ ws://127.0.0.1:19988/extension (token in query)
Chrome ── Browser Relay extension ── chrome.debugger ── the tabs you attached
```

- **The extension** (`extension/`) uses only the `debugger`, `storage`, `alarms` and `tabGroups` permissions. `tabGroups` lets it label controlled tabs in Chrome's tab strip. It has no host permissions and no remote code. It connects only to the relays listed in its options: by default the one on `127.0.0.1`, plus any `wss://` relays you add on other machines you own. It is loaded unpacked, so it never auto-updates.
- **The relay** (`src/relay.mjs`) presents each session's tabs through CDP. Playwright's `connectOverCDP` uses the token and session ID headers supplied by the MCP server.
- **The MCP server** (`src/mcp.mjs`) offers three tools: `session` (create, list, claim, release, close), `execute` (run a Playwright snippet), and `reset`. Every execution explicitly selects a session. It starts the relay in the background if it isn't running.

The only dependencies are `playwright-core` and `ws`, both pinned to exact versions.

## Which tabs agents can reach

Every session sees and controls only its own attached tabs:

- **Tabs you attach.** Clicking the toolbar button puts a tab in an orange **Browser Relay** group with an **ON** badge. It is available to claim, but no session can drive it until explicitly claimed.
- **Tabs a session opens** with `context.newPage()`. These open in the background and belong to that session automatically.
- **Named groups.** Claiming or opening a tab puts it in **Browser Relay · <relay name> · <session name>**, for example **Browser Relay · This computer · Checkout test**. Each session has a separate group in each window, even when names are identical.

For example, **Checkout test** sees its checkout tabs and **Docs research** sees its
research tabs. Neither session receives the other's CDP events or can issue commands
to the other's tabs or nested iframe sessions. The relay and extension both check
ownership. Your page titles and page contents are unchanged.

Chrome's "started debugging this browser" bar appears across browser windows; the
orange groups show which tabs the extension controls, including between tool calls.

Clicking the toolbar button again detaches that tab and restores its previous group,
recreating the group if Chrome removed it while empty. Pinned tabs are temporarily
unpinned for grouping and pinned again when detached. Tabs moved to another window
stay marked there; detaching them leaves them ungrouped in their new window.
Pressing **Cancel** on Chrome's debugging bar detaches all tabs controlled by the
extension. Closing a controlled tab removes its marker automatically.

## Named sessions

Use the `session` tool with these arguments. Keep the returned `id` for the task:

```json
{"action":"create","name":"Checkout test"}
```

Use the `session` tool to find and explicitly claim an attached tab:

```json
{"action":"list","sessionId":"<returned ID>"}
{"action":"claim","sessionId":"<returned ID>","tabId":123}
```

Then use `execute`:

```json
{"sessionId":"<returned ID>","code":"return await page.title()"}
```

Or open a new tab with `const p = await context.newPage(); setPage(p);`. `page` is
null until the session owns a tab. Its fallback is the most recent **owned** tab.
`state`, the selected page and the connection are separate for every session;
concurrent calls for one session run in order within an MCP process.

- `session` with `action: "release"`, `sessionId` and `tabId` detaches that tab and restores its previous group, leaving it open for you. Attach it again before another session claims it.
- `session` with `action: "close"` and `sessionId` releases all its tabs, leaves them open and removes the session. Closing a tab with `page.close()` still closes that tab normally.
- `reset` requires `sessionId`; it drops that connection and clears local state while preserving ownership.
- A snippet timeout disconnects only that session and requires a reset before retrying. Arbitrary local JavaScript cannot be forcibly cancelled; reset replaces its state object and reconnects its browser.
- Disconnects, MCP process crashes and relay restarts keep ownership reserved. Resume with the same ID; JavaScript `state` lasts only for the lifetime of that MCP process, until reset. Separate processes using the same ID share the same owned tabs intentionally.
- Manually detaching a tab overrides ownership immediately. Closing Chrome ends debugger attachments; its next launch does not automatically share restored tabs.

Session IDs and names are saved locally in `~/.config/browser-relay/sessions.json`.
Tab ownership and previous grouping live in the extension's session storage.

Clients using CDP directly first create a session with an authenticated JSON
`POST /sessions`, then connect to `/cdp` with both `Authorization: Bearer <token>`
and `x-browser-relay-session: <id>` headers. The JSON actions match the `session` tool.

## Using it from several machines

One Chrome can serve agents on several machines at once. Each machine runs its own
relay, with its own token and sessions, and the extension keeps one connection per
relay. A relay on another machine still listens only on its own `127.0.0.1`;
[`tailscale serve`](https://tailscale.com/kb/1312/serve) publishes its `/extension`
endpoint on your tailnet over HTTPS and tells it which Tailscale user is calling.

```
Mac                                         seraph-vm1
agent ── browser-relay mcp                  agent ── browser-relay mcp
                │ ws://…/cdp                                │ ws://127.0.0.1:19988/cdp
      relay on 127.0.0.1:19988                    relay on 127.0.0.1:19988
                │ ws://…/extension                          │ http://127.0.0.1:19988
Chrome ── extension                         tailscale serve :19443 (tailnet only)
                └──── wss://seraph-vm1.tail7ac3cb.ts.net:19443/extension ──┘
```

Attached tabs work the same way across relays:

- A tab you attach with the toolbar button is offered to every connected relay. The first session to claim it owns it; other relays stop listing it.
- A tab a session opens with `context.newPage()` belongs to that session's relay.
- CDP events for a tab go only to its relay. The extension refuses commands for a tab from any other relay, and each relay ignores tabs owned by sessions it doesn't know.
- Group titles name the relay, such as **Browser Relay · seraph-vm1 · Checkout test**, and the toolbar tooltip shows the owning session and relay.
- Each relay connects, retries and stays alive independently. A relay going away leaves other relays' tabs alone, and its own tabs stay reserved until it reconnects. Release, close and detach work as described above.
- Removing a relay from the options releases the tabs its sessions owned.

### On the other machine (Linux)

Keep the relay running without an MCP client, then publish it on the tailnet:

```
browser-relay service install
browser-relay remote enable --login you@example.com --apply
systemctl --user restart browser-relay.service
browser-relay remote
```

- `service install` writes a systemd `--user` unit with this checkout's paths and starts it. MCP servers on that machine use it instead of starting their own relay. Logs go to `journalctl --user -u browser-relay`. Run `sudo loginctl enable-linger $USER` once if it should run while you are logged out.
- `remote enable` writes `~/.config/browser-relay/config.json` and, with `--apply`, runs `tailscale serve --bg --https=19443 http://127.0.0.1:19988`. It refuses a port that Funnel or another service already uses. Without `--apply` it only prints the command. `--login` is the Tailscale login of the person whose Chrome connects (see `tailscale status --json`); repeat it for several. `--extension-id` optionally pins the extension ID that may connect.
- `remote` shows the current state and what to add to the extension. `remote disable --apply` removes the public host and runs `tailscale serve --https=19443 off`.

You can also write the settings yourself and run `tailscale serve` by hand:

```json
{
  "publicHosts": ["seraph-vm1.tail7ac3cb.ts.net:19443"],
  "allowedTailscaleLogins": ["you@example.com"],
  "allowedExtensionIds": []
}
```

`BROWSER_RELAY_PUBLIC_HOSTS`, `BROWSER_RELAY_TAILSCALE_LOGINS` and
`BROWSER_RELAY_EXTENSION_IDS` (comma-separated) override the file. Never use
`tailscale funnel` for this port: Funnel requests carry no Tailscale login, and the
relay refuses them.

### In Chrome

Open the extension's **Options** and click **Add a relay**:

- **Name:** a short label for group titles, such as `seraph-vm1`.
- **URL:** `wss://seraph-vm1.tail7ac3cb.ts.net:19443`. The options refuse plain `ws://` for anything but `127.0.0.1`, `localhost` and `[::1]`.
- **Token:** that machine's token. Copy it without displaying it, for example `ssh you@seraph-vm1.tail7ac3cb.ts.net browser-relay token | pbcopy` on a Mac, then paste it. `browser-relay remote` prints this command with absolute paths, for shells where `browser-relay` isn't on the `PATH`.

Each relay shows **connected**, **connecting**, **offline** or **needs a token**. Saved tokens are never shown again; leave the field blank to keep one.

### Upgrading from 0.2

Pull, reload the unpacked extension and restart the relay with `browser-relay stop`.
The extension turns the old token and port into a relay called **This computer**
on `ws://127.0.0.1:<port>`. Reloading the extension detaches its tabs, so attach and
claim them again. Group titles now include the relay name.

### Upgrading from 0.1

This API requires explicit session IDs. Reload the unpacked extension, restart the
relay with `browser-relay stop`, and reconnect your MCP client so it discovers the
new `session` tool and argument schemas. Tabs attached by the earlier version are
unclaimed. Create a named session and claim them before executing snippets.

## Setup

1. Run `pnpm install`.
2. In Chrome, open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension/` folder.
3. Run `browser-relay token --copy`. Then open the extension's **Options**, paste the token into **This computer** and click Save.
4. Register the MCP server with your client. For Claude Code, run this from the repository root:

   ```
   claude mcp add browser-relay --scope user -- "$(command -v node)" "$(pwd)/bin/browser-relay" mcp
   ```

   Register it again if you move the repository or change your Node installation.

## Security model

- **The token.** A random 32-byte token lives in `~/.config/browser-relay/token`, readable only by your user. Every HTTP request and WebSocket needs it. Tokens are compared in constant time. Each machine's relay has its own token, and the extension stores each relay's token separately.
- **The relay only listens on `127.0.0.1`.** HTTP requests with an `Origin` header are refused. Requests whose `Host` isn't `127.0.0.1:<port>`, `localhost:<port>` or a configured public host are refused, which blocks DNS rebinding.
- **Public hosts need a Tailscale login.** A request for a public host must have arrived through `tailscale serve`, which sets `Tailscale-User-Login` itself and drops any copy the client sent. Logins outside `allowedTailscaleLogins`, tagged devices (which get no login) and Funnel requests are refused before the token is checked. Over the tailnet the relay serves only `/extension` and `GET /health`; `/cdp`, `/sessions` and `/shutdown` stay loopback-only, so agents always run on the relay's own machine.
- **`/cdp` refuses any request that carries an `Origin` header.** Web pages always send one, and local tools such as Playwright don't. So even a page that learned the token could not drive your browser.
- **`/extension` only accepts `chrome-extension://` origins,** and only the IDs in `allowedExtensionIds` when that list is set.
- **Encryption.** The extension uses plain `ws://` only for loopback addresses. Other relays need `wss://`, which `tailscale serve` terminates with the machine's tailnet certificate. The token travels in the URL query because browsers can't set WebSocket headers; `tailscale serve` doesn't log it and the relay logs paths without queries.
- **What a remote relay can do.** Agents on that machine can drive the tabs its sessions own and open new background tabs in your profile, just like local agents. They never see tabs owned through other relays. Remove the relay from the options, or stop its `tailscale serve`, to cut it off.
- **Session boundaries.** These prevent accidental interference between cooperating tasks. They are not a sandbox for hostile code: all sessions use the same Chrome profile and share cookies/login state, and a trusted process with the relay token can explicitly resume another session ID. Snippets run as local JavaScript with `require`, not in a restricted runtime.
- **What the token can do.** Anything holding it can control the attached tabs and open new tabs in your profile. Treat it like an SSH key. To rotate it, delete the file, restart the relay (`browser-relay stop`, or `systemctl --user restart browser-relay.service`), and paste the new token into that relay's entry in the extension.

## Commands

```
browser-relay serve | mcp | token [--copy] | status | stop | remote … | service …
```

- The relay logs to `~/.config/browser-relay/relay.log` when the MCP server starts it, and to the journal when it runs as a service.
- `token --copy` uses `pbcopy` on macOS and `wl-copy`, `xclip` or `xsel` on Linux. It never falls back to printing the token.
- With the service installed, `browser-relay stop` restarts the relay; use `systemctl --user stop browser-relay.service` to stop it.
- The default port is 19988. Override it with `BROWSER_RELAY_PORT`, and set the same port in the extension options.

## Troubleshooting

Run `browser-relay status` after the first MCP call starts the relay. `extension: true`
means the extension is connected; `tabs: 0` means no tab is attached yet. Click the
toolbar button in the Chrome profile where Browser Relay is installed to attach one.

If a relay on another machine stays **offline** in the options, check `browser-relay remote`
on that machine (`tailscale serve` must show its port as tailnet only), that your login
is in `allowedTailscaleLogins`, that the relay was restarted after `remote enable`, and
`journalctl --user -u browser-relay` for `rejected /extension` lines: 403 means the
host, login or extension ID was refused, 401 means the token is wrong. Chrome retries
each relay with a backoff of up to 30 seconds.

After changing the unpacked extension's source, click **Reload** for Browser Relay
on `chrome://extensions` in that profile. Chrome keeps the old service worker running
until the extension is reloaded. If the toolbar says another debugger is attached,
close that tab's DevTools or press **Cancel** on Chrome's debugging bar before
attaching it again.

## Test

```
pnpm test
```

The test uses a throwaway Chromium profile, tokens and ports (19989 and 19990), so your real Chrome is never touched. A second relay plays a relay on another machine, reached over `wss://` through a small stand-in for `tailscale serve`. It checks:
- that bad tokens, web origins and foreign hosts are rejected;
- that public hosts need an allowed Tailscale login and the token, refuse Funnel requests, and only reach `/extension` and `/health`;
- migrating 0.2 settings to a **This computer** relay, and refusing `ws://` to other hosts in the worker and the options page;
- two relays with different tokens on one extension: tabs offered to both with the first claim winning, tabs/events/commands kept to their own relay (including when a relay knows another relay's session ID), one relay restarting or stopping without disturbing the other, renaming a relay and removing one;
- attaching and claiming a tab, `execute`, `newPage`, `state`, screenshots, closing, and errors;
- multiple sessions within one MCP process and across two processes;
- foreign tab/iframe commands and events, concurrent claims, release/close, reset, crash and resume;
- controlled-tab group labels, previous-group restoration, pinned tabs and moving tabs between windows;
- cross-site iframes;
- reconnecting after the relay or extension worker restarts with the same ownership and working cross-site iframes;
- a timed-out execution disconnecting only its own session and recovering after reset.

It needs a Chromium that accepts `--load-extension`, which branded Chrome no longer does, and `openssl` for the test certificate. By default it uses the newest Chromium in the Playwright cache (macOS or Linux), or set `BROWSER_RELAY_TEST_CHROMIUM`.

## License

[MIT](LICENSE), copyright 2026 tempeste.

## Acknowledgements

Inspired by [Playwriter](https://github.com/remorses/playwriter).
