# @gscdump/cli

[![npm version](https://img.shields.io/npm/v/@gscdump/cli?color=yellow)](https://npmjs.com/package/@gscdump/cli)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/cli?color=yellow)](https://npm.chart.dev/@gscdump/cli)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> CLI for Google Search Console — sync to a local DuckDB/Parquet store, run typed queries, execute 29 SEO analyzers, and serve an MCP endpoint for AI assistants.

## Install

```bash
npm install -g @gscdump/cli
# or run with npx
npx @gscdump/cli
```

## Quick start

```bash
# First-run setup — OAuth with Google
gscdump init

# List sites
gscdump sites

# Sync the last 28 days to a local Parquet store
gscdump sync --site https://example.com

# Query the store
gscdump query --site https://example.com --dimensions page,query --limit 50

# Run an analyzer
gscdump analyze striking-distance --site https://example.com

# Start the MCP server
gscdump mcp
```

## Commands

| Command | Description |
|---|---|
| `init` | Full setup (OAuth + dataDir; offers to write a `.env` for portability) |
| `auth` | Manage authentication (`status`, `login`, `logout`, `refresh`) |
| `config` | Manage CLI configuration (`show`, `set`, `unset`, `path`, `validate`) |
| `doctor` | Health checks: auth, scopes, dataDir writability, API reachability |
| `sites [--owner-only] [--with-sitemaps]` | List available GSC sites |
| `sites add <url>` / `sites delete <url> [--yes]` | Register / remove a property in Search Console (add registers in unverified state) |
| `sites verify-token <url> [--method]` / `sites verify <url> [--method]` | Get a verification token, then trigger ownership verification (META/FILE/DNS_TXT/DNS_CNAME/ANALYTICS/TAG_MANAGER) |
| `sitemaps` | GSC CRUD, explicit live probes, and hosted canonical reads (`current`, `history`, `membership`, `lastmod`, `export`) |
| `inspect <url>` / `inspect batch [--concurrency]` | URL inspection (single URL or batch from file/stdin); renders index status, rich results, and AMP |
| `indexing` | Notify Google about URL changes (`submit`, `remove`, `status`, `batch [--concurrency] [--yes]`); supports `--retries` |
| `sync` | Sync GSC data to the local Parquet store; `--retry-failed`, `--dry-run` |
| `query` | Run a search analytics query (local store by default; `--live` hits GSC API). Filters: `--query`, `--page`, `--country`, `--device`, `--search-appearance`, `--type`, `--data-state`, `--aggregation-type`. `--explain` previews the request body; `--output -` writes to stdout. |
| `dump` | Export from the store to a directory (`--format parquet\|json\|ndjson\|csv`, `--tables`, `--all-sites`) |
| `analyze <tool>` | Run an SEO analyzer against the store (`--live` for row-based against fresh API) |
| `entities` | Snapshot URL inspections and indexing metadata into the local entity store |
| `store stats` | Show row/byte counts per table and on-disk footprint |
| `store compact` | Roll daily partitions older than N days into monthly files (`--dry-run`) |
| `store gc` | Delete orphaned objects past the grace window (`--dry-run`) |
| `store export` | Export the live store to a single `.duckdb` file |
| `store rollups rebuild` | Rebuild post-sync rollup tables |
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

### Global flags

- `--no-color` / `NO_COLOR` env: strip ANSI from stdout (stderr keeps colour for interactive use).
- `--config-dir <path>` / `GSCDUMP_CONFIG_DIR`: override `~/.config/gscdump`.
- `--profile <name>` / `GSCDUMP_PROFILE`: scope tokens + config to a profile under `~/.config/gscdump/profiles/<name>` (juggle multiple GSC accounts).
- Most commands accept `--quiet` and `--json` for scripted use; `logger` writes to stderr so `--json` output is safe to pipe.

## Analyzers

`gscdump analyze <tool>` dispatches to `@gscdump/analysis`. 21 tools available:

**Core SEO:** `striking-distance`, `opportunity`, `movers`, `decay`, `zero-click`, `brand`, `cannibalization`

**Statistical:** `ctr-anomaly`, `position-volatility`, `bayesian-ctr`, `stl-decompose`, `change-point`, `survival`

**Structural:** `long-tail`, `intent-atlas`, `query-migration`, `clustering`, `concentration`, `seasonality`, `trends`, `bipartite-pagerank`

Each analyzer accepts `--site`, date range flags, and tool-specific options (see `gscdump analyze <tool> --help`). Pass `--live` to bypass the local store and run against fresh GSC API results.

## Sync

```bash
# Default: sync the last 7 days, skipping dates already marked done
gscdump sync --site https://example.com

# Backfill the full 450-day history
gscdump sync --site https://example.com --full

# Custom range
gscdump sync --site https://example.com --start 2024-01-01 --end 2024-01-31

# Check status — watermarks + pending/inflight/done/failed counts
gscdump sync --site https://example.com --status

# Parallel table fetches
gscdump sync --site https://example.com --concurrency 4
```

Sync is idempotent. Cross-process locking protects concurrent `sync`/`compact`/`gc` runs. Pagination walks past GSC's 25k-row-per-request cap automatically.

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
      "args": ["@gscdump/cli", "mcp"]
    }
  }
}
```

Then ask questions like:

- "What pages lost traffic this week?"
- "Find keywords in striking distance (position 4-20)."
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

# Option B: refresh-token flow (no google-auth-library dep used)
export GSC_CLIENT_ID=...
export GSC_CLIENT_SECRET=...
export GSC_REFRESH_TOKEN=...
```

When BYOK is detected, `gscdump auth status` reports `byok` as the source and `gscdump auth login` is a no-op.

### Service account

For CI / headless usage, point `gscdump` at a service-account JSON key. The service account must be granted access to each property in Search Console (Settings → Users and permissions).

```bash
gscdump auth login --service-account ./gsc-sa.json   # smoke-test the key
export GOOGLE_APPLICATION_CREDENTIALS=$(realpath ./gsc-sa.json)
gscdump sites
```

### Headless OAuth

When the loopback flow can't open a browser (servers, containers, WSL2 without forwarding), use the device-code flow:

```bash
gscdump auth login --no-browser
# → opens a verification URL on any device; type the displayed user code
```

## Related

- [`gscdump`](../gscdump) — Core library: GSC API client + query builder + analytics pipeline.
- [`@gscdump/engine`](../engine) — Storage engine the CLI syncs into.
- [`@gscdump/analysis`](../analysis) — SEO analyzers (row-based + DuckDB-native).

## License

[MIT](../../LICENSE)
