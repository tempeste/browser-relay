# AGENTS.MD

- Plain Node ESM, no build step, Node >= 22. The extension is plain MV3 JS loaded unpacked.
- Keep it small and auditable: no new dependencies without a strong reason, and keep extension permissions at `debugger`, `storage`, `alarms` (no host permissions, no remote endpoints other than 127.0.0.1).
- Run `pnpm test` after any change to the relay, extension or MCP server; it runs a real Chromium end to end.
- Security rules live in `README.md` (token, Host check, Origin rules). Don't weaken them.
