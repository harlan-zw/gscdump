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

The server accepts the CLI's `GSC_ACCESS_TOKEN`, service-account, and OAuth refresh-token configuration.
Configure credentials in the server process.
Tool responses can contain your search data; review your MCP client's data-sharing settings.

## Tool groups

Available tool groups:

- Search Console Sites and verification (`list-sites`, `add-site`,
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

- “List my Search Console Sites.”
- “Run the movers report for `sc-domain:example.com` over the last 28 days.”
- “Query clicks and impressions by page for this month.”
- “Inspect these URLs and summarize the Indexing Evidence.”

MCP Reports use the live Google API.
They do not read the local Store.
Reports with required SQL-only steps, such as `health`, cannot run through this MCP handler.
Use the CLI for Reports that need stored data.

`run-report` currently accepts the Site, Report ID, date windows, comparison, and maximum findings.
It does not forward `target`, `topic`, or `brandTerms`.
Use the CLI for `triage`, `pre-publish`, and `brand`.

Indexing notifications follow [Google's eligibility requirements](./url-indexing.md#send-eligible-indexing-notifications).
