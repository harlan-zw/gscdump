# @gscdump/cli

[![npm version](https://img.shields.io/npm/v/@gscdump/cli?color=yellow)](https://npmjs.com/package/@gscdump/cli)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/cli?color=yellow)](https://npm.chart.dev/@gscdump/cli)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> CLI for Google Search Console — sync to a local DuckDB/Parquet store, run typed queries, execute 21 SEO analyzers, and serve an MCP endpoint for AI assistants.

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
| `init` | Set up GSCDump authentication |
| `auth` | Manage authentication (`status`, `logout`) |
| `config` | Manage CLI configuration (`show`, `set`, `unset`, `path`) |
| `sites` | List available GSC sites |
| `sitemaps` | List/manage sitemaps for a site |
| `inspect` | Inspect a URL's indexing status |
| `sync` | Sync GSC data to the local Parquet store |
| `query` | Run a search analytics query (local store by default; `--live` hits GSC API) |
| `dump` | Export live Parquet files from the store to a directory |
| `analyze <tool>` | Run an SEO analyzer against the store (`--live` for row-based against fresh API) |
| `store stats` | Show row/byte counts per table and on-disk footprint |
| `store compact` | Roll daily partitions older than N days into monthly files |
| `store gc` | Delete orphaned objects past the grace window |
| `store export` | Export raw Parquet files |
| `mcp` | Start the MCP server for AI assistants |

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

`gscdump init` walks you through OAuth2 with Google. Credentials are stored locally under `~/.config/gscdump/` (XDG) or equivalent.

For manual setup:

1. Create a Google Cloud project.
2. Enable **Search Console API** and **Web Search Indexing API**.
3. Create OAuth2 credentials (Desktop app).
4. Run `gscdump init`.

## Related

- [`gscdump`](../gscdump) — Core library: GSC API client + query builder + analytics pipeline.
- [`@gscdump/engine`](../engine) — Storage engine the CLI syncs into.
- [`@gscdump/analysis`](../analysis) — SEO analyzers (row-based + DuckDB-native).
- [`@gscdump/nuxt-analytics`](../nuxt-analytics) — Nuxt layer for embedding analytics dashboards.

## License

[MIT](../../LICENSE)
