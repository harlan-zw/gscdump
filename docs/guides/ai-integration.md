# AI integration

`@gscdump/cli` owns the MCP server. Authenticate once with `gscdump init` (or
provide BYOK environment variables), then start it with `gscdump mcp`.

## Agent skill

The package ships a skill at `skills/gscdump/SKILL.md` for coding agents that
run the CLI directly. It documents every command, the JSON output rules, the
data boundaries, and the guardrails.

```bash
gscdump skill install --agent claude    # Codex: --agent codex
```

The same file is published at [gscdump.com/SKILL.md](https://gscdump.com/SKILL.md).

## Papercuts

Agents and people can report CLI problems without an account:

```bash
gscdump papercut --command "report triage" --agent "Claude Code" \
  --comment "Agent report by Claude Code. Expected --target-kind in --help. Received an unknown flag error." \
  --yes --json
```

The CLI adds its version, Node version, and platform. The endpoint is
anonymous and allows ten reports per network address each hour. Send
sanitized details only.

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
- “Run the brand Report for `sc-domain:example.com` with brand terms `example,example.com`.”
- “Run the pre-publish Report for `sc-domain:example.com` with topic `running shoes`.”
- “Query clicks and impressions by page for this month.”
- “Inspect these URLs and summarize the Indexing Evidence.”

MCP Reports use the live Google API.
They do not read the local Store.
`list-reports` advertises only Reports with supported inputs and at least one live Section.
Every required Analyzer must support the live Source.
The supported Reports are `brand`, `movers`, `opportunities`, `pre-publish`, and `risks`.

`health`, `growth`, and `triage` require the local Store.
MCP rejects them before authentication or Google requests.
Run them with `gscdump report <id>` after syncing the Site.

`run-report` accepts the Site, Report ID, date windows, comparison, and `maxFindings`.
Report inputs use the same names shown in `list-reports.argsSpec`:

| Report | Additional inputs |
| --- | --- |
| `brand` | `brandTerms`: required comma-separated brand terms |
| `movers` | `minClicksChange`: minimum absolute click change, default `5` |
| `pre-publish` | `topic`: required topic or URL slug |

Example `run-report` arguments:

```json
{
  "siteUrl": "sc-domain:example.com",
  "id": "brand",
  "period": "28d",
  "brandTerms": "example,example.com",
  "maxFindings": 5
}
```

Optional Analyzers can require SQL even when the Report supports the live Source.
Unavailable Sections have `severity: "unknown"` and `coverage: "partial"`.
The Report sets `meta.degraded` to `true` and records failed Analyzers in `meta.steps`.
Treat these Sections as unavailable evidence. Use the local Store for complete SQL coverage.

Indexing notifications follow [Google's eligibility requirements](./url-indexing.md#send-eligible-indexing-notifications).
