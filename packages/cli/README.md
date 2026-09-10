# @gscdump/cli

[![npm version](https://img.shields.io/npm/v/@gscdump/cli?color=yellow)](https://npmjs.com/package/@gscdump/cli)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/cli?color=yellow)](https://npm.chart.dev/@gscdump/cli)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

Query Google Search Console, sync a local Parquet Store, and run SEO Analyzers or Reports.
The package also provides the MCP server.
Node.js 22 or newer is required.

## Install

```bash
npm install -g @gscdump/cli
# or run with npx
npx @gscdump/cli
```

## Quick start

```bash
# Set up Google OAuth
gscdump init

# List sites
gscdump sites

# Sync 90 days to the Store
gscdump sync --site sc-domain:example.com --days 90 --tables pages,queries,page_queries,countries

# Query the Store
gscdump query --site sc-domain:example.com --dimensions page,query --limit 50

# Run an Analyzer
gscdump analyze striking-distance --site sc-domain:example.com

# Start the MCP server
gscdump mcp
```

## Commands

| Command | Description |
|---|---|
| `init` | Full setup (OAuth + dataDir; offers to write a `.env` for later use) |
| `auth` | Manage authentication (`status`, `login`, `logout`, `refresh`) |
| `config` | Manage CLI configuration (`show`, `set`, `unset`, `path`, `validate`) |
| `doctor` | Health checks: auth, scopes, dataDir writability, API reachability |
| `sites [--owner-only] [--with-sitemaps]` | List available GSC sites |
| `sites add <url>` / `sites delete <url> [--yes]` | Register or remove a Site in Search Console (add registers in unverified state) |
| `sites verify-token <url> [--method]` / `sites verify <url> [--method]` | Get a verification token, then trigger ownership verification (META/FILE/DNS_TXT/DNS_CNAME/ANALYTICS/TAG_MANAGER) |
| `sitemaps` | List, submit, or delete Google sitemaps; probe live URLs; read hosted snapshots (`current`, `history`, `membership`, `lastmod`, `export`) |
| `inspect <url>` / `inspect batch [--concurrency]` | URL inspection (single URL or batch from file/stdin); renders Indexing Evidence, rich results, and AMP |
| `indexing` | Notify Google about URL changes (`submit`, `remove`, `status`, `batch`, `batch-status`, `quota`); supports `--retries` |
| `sync` | Sync GSC data to the local Parquet Store; `--retry-failed`, `--dry-run` |
| `query` | Run a search analytics query (Store by default; `--live` hits GSC API). Filters: `--query`, `--page`, `--country`, `--device`, `--search-appearance`, `--type`, `--data-state`, `--aggregation-type`. `--explain` previews the request body; `--output -` writes to stdout. |
| `dump` | Export from the Store to a directory (`--format parquet\|json\|ndjson\|csv`, `--tables`, `--all-sites`) |
| `analyze <tool>` | Run an SEO Analyzer against the Store (`--live` for row-based against fresh API) |
| `entities` | Snapshot URL inspections and indexing metadata into the local entity store |
| `store stats` | Show row/byte counts per table and on-disk footprint |
| `store compact` | Compact older data into weekly, monthly, and quarterly tiers (`--dry-run`) |
| `store gc` | Delete orphaned objects past the grace window (`--dry-run`) |
| `store export` | Export the live store to a single `.duckdb` file |
| `store rm-site` / `store reset` | Delete one Site's data or reset the Store; inspect `--help` before use |
| `store rollups rebuild` | Rebuild post-sync rollup tables |
| `report <id>` / `report list` | Run or list Reports; `--explain` previews a plan |
| `profile` | Create, select, list, or delete credential profiles |
| `mcp` | Start the MCP server for AI assistants |

### Filter expressions

`query` accepts prefix-encoded filter expressions for `--query`, `--page`, `--country`, `--device`, `--search-appearance`:

| Prefix | Operator |
|---|---|
| (bare) | equals |
| `~foo` | contains |
| `!~foo` | not contains |
| `re:foo` | regex |
| `!re:foo` | not regex |
| `!foo` | not equals |

```bash
# pages under /blog/ with brand mentions in the query
gscdump query --live --site sc-domain:example.com \
  --page '~/blog/' --query '~brand' --dimensions page,query
```

`--limit` and `--format` override saved `defaultLimit` and `defaultFormat` values.
Without saved values, queries use 1000 rows and JSON.
Limits must be positive integers. Formats must be `json` or `csv`.

`--start` and `--end` work independently. An omitted date keeps its default.
Non-interactive queries default to 31 days ago through three days ago, using UTC dates.
Dates must use `YYYY-MM-DD`, and `--start` cannot follow `--end`.

```bash
# Export query rows with a CSV header.
gscdump query --live --site sc-domain:example.com \
  --dimensions page,query --format csv --output rows.csv
```

### Global flags

- `--no-color` / `NO_COLOR` env: strip ANSI from stdout (stderr keeps colour for interactive use).
- `--config-dir <path>` / `GSCDUMP_CONFIG_DIR`: override `~/.config/gscdump`.
- `--profile <name>` / `GSCDUMP_PROFILE`: separate tokens and config to a profile under `~/.config/gscdump/profiles/<name>` (separate Google credentials).
- Most commands accept `--quiet` and `--json` for scripts. The `query` command uses `--format json` instead.

Use `query --profile` for query timings. Use `--profile <name>` to select a credential profile.
Numeric flags reject fractions, negative counts, and text suffixes.
Saved config rejects invalid values and unknown keys. If parsing fails, fix the reported file.

## Analyzers

`gscdump analyze <tool>` runs one of 29 Analyzers from `@gscdump/analysis`.
See the [full list](../../README.md#analyzers) and [Source support](../analysis/README.md#sources).

Each Analyzer accepts `--site`, `--start`, `--end`, `--limit`, and output flags.
`movers` and `decay` also accept `--prev-start` and `--prev-end`.
Use `gscdump analyze <tool> --help` for additional options.

The CLI requires local data unless you pass `--live`.
Pass `--live` to use Google explicitly.
SQL-only Analyzers require local data.

## Sync

```bash
# Default: three days ending three days ago; skip completed dates
gscdump sync --site sc-domain:example.com --tables pages,queries,page_queries,countries

# Backfill from 450 days ago to three days ago
gscdump sync --site sc-domain:example.com --full --tables pages,queries,page_queries,countries

# Custom range
gscdump sync --site sc-domain:example.com --start 2026-08-01 --end 2026-08-31 \
  --tables pages,queries,page_queries,countries

# Check sync state and watermarks
gscdump sync --site sc-domain:example.com --status

# Limit concurrent day requests per table
gscdump sync --site sc-domain:example.com --concurrency 4 \
  --tables pages,queries,page_queries,countries
```

The explicit table list avoids the current [daily totals sync limitation](../../docs/guides/historical-database.md#stored-tables).
Sync skips completed dates; `--force` refreshes them.
Cross-process locks coordinate `sync`, `compact`, and `gc`.
Pagination follows Google's 25,000-row pages, subject to [Google's data limits](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data).

## MCP server

Expose your GSC data to AI assistants over the Model Context Protocol.

```bash
gscdump mcp
```

Add to your Claude / VS Code config:

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

Then ask questions like:

- "What pages lost traffic this week?"
- "Find queries in striking distance (positions 4 to 20)."
- "Which queries have cannibalization issues?"
- "Compare this month vs last month for /blog/ pages."

## Auth

`gscdump init` walks you through full setup (OAuth + data dir). Credentials are stored locally under `~/.config/gscdump/` (XDG) or equivalent. Use `gscdump auth login` if you only want to refresh OAuth tokens without touching config.

For manual setup:

1. Create a Google Cloud project.
2. Enable **Search Console API** and **Web Search Indexing API**.
3. Create OAuth2 credentials (Desktop app).
4. Run `gscdump init` (or `gscdump auth login`).

### BYOK (Bring Your Own Key)

Skip `init` entirely by setting env vars. Either path works (`GSC_*` preferred, `GOOGLE_*` accepted):

```bash
# Option A: raw bearer token (e.g., from gcloud or another OAuth flow)
export GSC_ACCESS_TOKEN=ya29...

# Option B: refresh-token flow (OAuth refresh credentials)
export GSC_CLIENT_ID=...
export GSC_CLIENT_SECRET=...
export GSC_REFRESH_TOKEN=...
```

`gscdump auth status` shows which credential source is active.
`auth login` skips OAuth when it finds BYOK credentials.

### Service account

For CI / headless usage, point `gscdump` at a service-account JSON key. Grant the service account access to each Site in Search Console under Settings → Users and permissions.

```bash
gscdump auth login --service-account ./gsc-sa.json   # smoke-test the key
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/gsc-sa.json
gscdump sites
```

### Headless OAuth

When the loopback flow can't open a browser (servers, containers, WSL2 without forwarding), use the device-code flow:

```bash
gscdump auth login --no-browser
# → opens a verification URL on any device; type the displayed user code
```

The device-code flow requires a Google OAuth client and scopes that support this flow.
If Google rejects the flow, use a refresh token or service account.

Indexing notifications apply only to eligible job or livestream pages.
See [URL inspection and indexing](../../docs/guides/url-indexing.md).

## Related

- [`gscdump`](../gscdump) : Google and Bing clients with a typed query builder.
- [`@gscdump/engine`](../engine) : Storage engine the CLI syncs into.
- [`@gscdump/analysis`](../analysis) : SEO Analyzers (row-based + DuckDB-native).

## License

[MIT](../../LICENSE)
