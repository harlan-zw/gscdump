# AI integration

`@gscdump/cli` owns the MCP server. It uses the CLI's selected cloud or local authentication for Google tools.
Authenticate with `gscdump auth login --mode cloud`, or configure local Google credentials, then run `gscdump mcp`.
See [authentication setup](./getting-started.md#install-and-authenticate).

## Agent skill

The package ships a skill at `skills/gscdump/SKILL.md` for coding agents that
run the CLI directly. It documents every command, the JSON output rules, the
data boundaries, and the guardrails.

```bash
gscdump skill install --agent claude    # Codex: --agent codex
```

The same file is published at [gscdump.com/SKILL.md](https://gscdump.com/SKILL.md).
After upgrading the CLI, run `skill install` again to update an installed copy.

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

The server uses the saved authentication for its profile.
Cloud mode accepts `GSCDUMP_API_KEY`. Local mode accepts Google access tokens, service accounts, and OAuth refresh tokens.
Set environment credentials in the server process. Use `--profile NAME` or `--mode local` in its arguments when needed.
Cloud Google tools use gscdump.com. Google Indexing API and Site Verification tools require local mode.
Bing commands are available through the CLI and agent skill. The MCP server does not expose Bing tools.
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
- “Run the movers report for `example.com` over the last 28 days.”
- “Run the brand Report for `example.com` with brand terms `example,example.com`.”
- “Run the pre-publish Report for `example.com` with topic `running shoes`.”
- “Query clicks and impressions by page for this month.”
- “Inspect these URLs and summarize the Indexing Evidence.”

MCP Reports read live Google data through the selected authentication mode.
They do not read the local Store.
`list-reports` advertises only Reports with supported inputs and at least one live Section.
Every required Analyzer must support the live Source.
The supported Reports are `brand`, `movers`, `opportunities`, `pre-publish`, and `risks`.

`health`, `growth`, and `triage` require the local Store.
MCP rejects them before authentication or Google requests.
Run them with `gscdump report <id>` after syncing the Site.

`run-report` accepts the Site, Report ID, date windows, comparison, and `maxFindings`.
Every tool that takes `siteUrl` accepts a Site as a person writes it, such as `example.com`. The tool resolves it against your Search Console Sites.
Report inputs use the same names shown in `list-reports.argsSpec`:

| Report | Additional inputs |
| --- | --- |
| `brand` | `brandTerms`: required comma-separated brand terms |
| `movers` | `minClicksChange`: minimum absolute click change, default `5` |
| `pre-publish` | `topic`: required topic or URL slug |

Example `run-report` arguments:

```json
{
  "siteUrl": "example.com",
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
