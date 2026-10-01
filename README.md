# browser-relay

Lets local agents drive tabs in your real, logged-in Chrome through a local relay and an unpacked extension. Each task uses a named session with its own tabs and a visible Chrome tab group.

```
agent ── MCP (stdio) ── browser-relay mcp ──┐
                                            │ ws://127.0.0.1:19988/cdp   (token in header)
                                     browser-relay serve (relay)
                                            │ ws://127.0.0.1:19988/extension (token in query)
Chrome ── Browser Relay extension ── chrome.debugger ── the tabs you attached
```

- **The extension** (`extension/`) uses only the `debugger`, `storage`, `alarms` and `tabGroups` permissions. `tabGroups` lets it label controlled tabs in Chrome's tab strip. It has no host permissions and no remote code, and it only ever connects to `127.0.0.1`. It is loaded unpacked, so it never auto-updates.
- **The relay** (`src/relay.mjs`) presents each session's tabs through CDP. Playwright's `connectOverCDP` uses the token and session ID headers supplied by the MCP server.
- **The MCP server** (`src/mcp.mjs`) offers three tools: `session` (create, list, claim, release, close), `execute` (run a Playwright snippet), and `reset`. Every execution explicitly selects a session. It starts the relay in the background if it isn't running.

The only dependencies are `playwright-core` and `ws`, both pinned to exact versions.

## Which tabs agents can reach

Every session sees and controls only its own attached tabs:

- **Tabs you attach.** Clicking the toolbar button puts a tab in an orange **Browser Relay** group with an **ON** badge. It is available to claim, but no session can drive it until explicitly claimed.
- **Tabs a session opens** with `context.newPage()`. These open in the background and belong to that session automatically.
- **Named groups.** Claiming or opening a tab puts it in **Browser Relay · <session name>**. Each session has a separate group in each window, even when names are identical.

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

### Upgrading from 0.1

This API requires explicit session IDs. Reload the unpacked extension, restart the
relay with `browser-relay stop`, and reconnect your MCP client so it discovers the
new `session` tool and argument schemas. Tabs attached by the earlier version are
unclaimed. Create a named session and claim them before executing snippets.

## Setup

1. Run `pnpm install`.
2. In Chrome, open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension/` folder.
3. Run `browser-relay token --copy`. Then open the extension's **Options**, paste the token and click Save.
4. Register the MCP server with your client. For Claude Code, run this from the repository root:

   ```
   claude mcp add browser-relay --scope user -- "$(command -v node)" "$(pwd)/bin/browser-relay" mcp
   ```

   Register it again if you move the repository or change your Node installation.

## Security model

- **The token.** A random 32-byte token lives in `~/.config/browser-relay/token`, readable only by your user. Every HTTP request and WebSocket needs it. Tokens are compared in constant time.
- **The relay only listens on `127.0.0.1`.** HTTP requests with an `Origin` header are refused. Requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` are refused, which blocks DNS rebinding.
- **`/cdp` refuses any request that carries an `Origin` header.** Web pages always send one, and local tools such as Playwright don't. So even a page that learned the token could not drive your browser.
- **`/extension` only accepts `chrome-extension://` origins.**
- **Session boundaries.** These prevent accidental interference between cooperating tasks. They are not a sandbox for hostile code: all sessions use the same Chrome profile and share cookies/login state, and a trusted process with the relay token can explicitly resume another session ID. Snippets run as local JavaScript with `require`, not in a restricted runtime.
- **What the token can do.** Anything holding it can control the attached tabs and open new tabs in your profile. Treat it like an SSH key. To rotate it, delete the file, run `browser-relay stop`, and paste the new token into the extension.

## Commands

```
browser-relay serve | mcp | token [--copy] | status | stop
```

- The relay logs to `~/.config/browser-relay/relay.log` when the MCP server starts it.
- The default port is 19988. Override it with `BROWSER_RELAY_PORT`, and set the same port in the extension options.

## Troubleshooting

Run `browser-relay status` after the first MCP call starts the relay. `extension: true`
means the extension is connected; `tabs: 0` means no tab is attached yet. Click the
toolbar button in the Chrome profile where Browser Relay is installed to attach one.

After changing the unpacked extension's source, click **Reload** for Browser Relay
on `chrome://extensions` in that profile. Chrome keeps the old service worker running
until the extension is reloaded. If the toolbar says another debugger is attached,
close that tab's DevTools or press **Cancel** on Chrome's debugging bar before
attaching it again.

## Test

```
pnpm test
```

The test uses a throwaway Chromium profile, token and port (19989), so your real Chrome is never touched. It checks:
- that bad tokens, web origins and foreign hosts are rejected;
- attaching and claiming a tab, `execute`, `newPage`, `state`, screenshots, closing, and errors;
- multiple sessions within one MCP process and across two processes;
- foreign tab/iframe commands and events, concurrent claims, release/close, reset, crash and resume;
- controlled-tab group labels, previous-group restoration, pinned tabs and moving tabs between windows;
- cross-site iframes;
- reconnecting after the relay or extension worker restarts with the same ownership and working cross-site iframes;
- a timed-out execution disconnecting only its own session and recovering after reset.

It needs a Chromium that accepts `--load-extension`, which branded Chrome no longer does. By default it uses the newest one in the Playwright cache, or set `BROWSER_RELAY_TEST_CHROMIUM`.

## License

[MIT](LICENSE), copyright 2026 tempeste.

## Acknowledgements

Inspired by [Playwriter](https://github.com/remorses/playwriter).
