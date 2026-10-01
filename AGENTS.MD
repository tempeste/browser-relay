# AGENTS.MD

- Plain Node ESM, no build step, Node >= 22. The extension is plain MV3 JS loaded unpacked.
- Keep it small and auditable: no new dependencies without a strong reason, and keep extension permissions at `debugger`, `storage`, `alarms`, `tabGroups` (no host permissions, no remote endpoints other than 127.0.0.1). `tabGroups` is only for marking controlled tabs in the tab strip and restoring their previous grouping.
- Run `pnpm test` after any change to the relay, extension or MCP server; it runs a real Chromium end to end.
- Security rules live in `README.md` (token, Host check, Origin rules). Don't weaken them.
