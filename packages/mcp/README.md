# @gscdump/mcp

Internal workspace package. The MCP server implementation that powers `gscdump mcp` (via [`@gscdump/cli`](../cli)).

Marked `"private": true` — not published to npm. Consumed only by `@gscdump/cli`, which re-exposes the server behind the `gscdump mcp` command and the `gscdump-mcp` bin.

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

## License

[MIT](../../LICENSE)
