# @gscdump/mcp

[![status: internal](https://img.shields.io/badge/status-internal-lightgrey)](#publishing-trigger)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> MCP server for Google Search Console. **Frozen — not under active development.** Internal workspace package powering `gscdump mcp`.

Marked `"private": true` — not published to npm. Consumed only by [`@gscdump/cli`](../cli), which re-exposes the server behind the `gscdump mcp` command and the `gscdump-mcp` bin.

## Why this split exists

The server surface (handlers, tools, transport) lives here so that the CLI package stays scoped to command-line orchestration. Nothing here depends on citty or any CLI-specific code; if a second consumer needs an MCP server over `gscdump` data (e.g. a hosted endpoint), they can depend on this package directly.

## Running the server

Through the CLI:

```bash
npx @gscdump/cli mcp
```

In a Claude / VS Code config:

```json
{
  "mcpServers": {
    "gscdump": {
      "command": "npx",
      "args": ["@gscdump/cli", "mcp"]
    }
  }
}
```

## Publishing trigger

Flip `"private": false` and publish when there's a concrete second consumer that needs the server independent of the CLI (a hosted MCP endpoint, a separate agent runtime, etc.). Until then, the CLI is the only public entry point.

## Related

- [`@gscdump/cli`](../cli) — CLI consumer that exposes `gscdump mcp`.
- [`gscdump`](../gscdump) — REST client + query builder used by the server.

## License

[MIT](../../LICENSE)
