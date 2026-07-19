# AI integration

`@gscdump/cli` owns the MCP server. Authenticate once with `gscdump init` (or
provide BYOK environment variables), then start it with `gscdump mcp`.

## MCP client configuration

Use the same command in Claude Desktop, Claude Code, Cursor, or another
stdio-compatible MCP client:

```json
{
  "mcpServers": {
    "gscdump": {
      "command": "npx",
      "args": ["-y", "@gscdump/cli", "mcp"]
    }
  }
}
```

The server also accepts the CLI's `GSC_ACCESS_TOKEN`, service-account, and
OAuth refresh-token configuration. Secrets stay in the local MCP process and
are not sent to the model.

## Tool groups

The current server exposes:

- Search Console sites and verification (`list-sites`, `add-site`,
  `verify-site`, and related tools).
- Sitemaps (`list-sitemaps`, `get-sitemap`, `submit-sitemap`,
  `delete-sitemap`, `discover-sitemap`).
- Report discovery and execution (`list-reports`, `run-report`).
- Typed custom Search Analytics queries (`query`).
- URL inspection and indexing requests, including batch variants.
- `diagnostics` for credential/scope checks.

Run `npx -y @gscdump/cli mcp` through an MCP inspector to see the live input
schemas. The former `@gscdump/mcp` package and its programmatic server subpath
were removed; application embedding is not a supported v1 package surface.

## Example prompts

- “List my Search Console properties.”
- “Run the priority report for `sc-domain:example.com` over the last 28 days.”
- “Query clicks and impressions by page for this month.”
- “Inspect these URLs and summarize indexing failures.”
