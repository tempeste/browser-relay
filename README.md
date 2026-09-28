# browser-relay

Lets local agents drive tabs in your real, logged-in Chrome through a local relay and an unpacked extension. All the code is small enough to read in one sitting.

```
agent ── MCP (stdio) ── browser-relay mcp ──┐
                                            │ ws://127.0.0.1:19988/cdp   (token in header)
                                     browser-relay serve (relay)
                                            │ ws://127.0.0.1:19988/extension (token in query)
Chrome ── Browser Relay extension ── chrome.debugger ── the tabs you attached
```

- **The extension** (`extension/`) uses only the `debugger`, `storage` and `alarms` permissions. It has no host permissions and no remote code, and it only ever connects to `127.0.0.1`. It is loaded unpacked, so it never auto-updates.
- **The relay** (`src/relay.mjs`) makes the attached tabs look like an ordinary Chrome, so Playwright's `connectOverCDP` works unchanged.
- **The MCP server** (`src/mcp.mjs`) offers two tools, `execute` (run a Playwright snippet) and `reset`. It starts the relay in the background if it isn't running.

The only dependencies are `playwright-core` and `ws`, both pinned to exact versions.

## Which tabs agents can reach

Agents can reach only two kinds of tab:
- **Tabs you attach.** Clicking the toolbar button toggles a tab. Its badge shows **ON**, and Chrome shows a "started debugging this browser" bar.
- **Tabs an agent opens** with `context.newPage()`. These open as background tabs and are attached automatically.

Pressing **Cancel** on Chrome's debugging bar, or clicking the toolbar button again, detaches a tab.

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
- **The relay only listens on `127.0.0.1`.** Requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` are refused, which blocks DNS rebinding.
- **`/cdp` refuses any request that carries an `Origin` header.** Web pages always send one, and local tools such as Playwright don't. So even a page that learned the token could not drive your browser.
- **`/extension` only accepts `chrome-extension://` origins.**
- **What the token can do.** Anything holding it can control the attached tabs and open new tabs in your profile. Treat it like an SSH key. To rotate it, delete the file, run `browser-relay stop`, and paste the new token into the extension.

## Commands

```
browser-relay serve | mcp | token [--copy] | status | stop
```

- The relay logs to `~/.config/browser-relay/relay.log` when the MCP server starts it.
- The default port is 19988. Override it with `BROWSER_RELAY_PORT`, and set the same port in the extension options.

## Test

```
pnpm test
```

The test uses a throwaway Chromium profile, token and port (19989), so your real Chrome is never touched. It checks:
- that bad tokens, web origins and foreign hosts are rejected;
- attaching a tab, `execute`, `newPage`, `state`, screenshots, closing, and errors;
- cross-site iframes;
- reconnecting after the relay restarts.

It needs a Chromium that accepts `--load-extension`, which branded Chrome no longer does. By default it uses the newest one in the Playwright cache, or set `BROWSER_RELAY_TEST_CHROMIUM`.
