# @gscdump/cli

[![npm version](https://img.shields.io/npm/v/@gscdump/cli?color=yellow)](https://npmjs.com/package/@gscdump/cli)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/cli?color=yellow)](https://npm.chart.dev/@gscdump/cli)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

Query Google Search Console and Bing with hosted or local authentication.
Sync Google rows to a local Parquet Store, and run SEO Analyzers or Reports.
The package also provides the MCP server.
Use Node.js 22.13 or later in the 22 release line, or Node.js 24 or later.

## Install

```bash
npm install -g @gscdump/cli
# or run with npx
npx @gscdump/cli
```

## Quick start

```bash
# Connect Google for free local CLI use
gscdump init --mode local
gscdump auth login --mode local

# List sites
gscdump sites

# Sync 90 days to the Store
gscdump sync --site sc-domain:example.com --days 90 --tables pages,queries,page_queries,countries,dates

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
| `init` | Full setup (OAuth + dataDir; offers to write a `.env` for later use). `--mode cloud\|local` saves the auth mode. Without a terminal it never prompts |
| `auth` | Manage authentication (`status`, `login`, `logout`, `refresh`) |
| `bing` | Connect Bing, list sites, dump datasets, inspect URLs, and check hosted verification |
| `config` | Manage CLI configuration (`show`, `set`, `unset`, `path`, `validate`) |
| `doctor` | Health checks: auth, scopes, dataDir writability, API reachability |
| `sites [--owner-only] [--with-sitemaps]` | List available GSC sites |
| `sites add <url>` / `sites delete <url> [--yes]` | Register or remove a Site in Search Console (add registers in unverified state) |
| `sites verify-token <url> [--method]` / `sites verify <url> [--method]` | Get a verification token, then trigger ownership verification (META/FILE/DNS_TXT/DNS_CNAME/ANALYTICS/TAG_MANAGER) |
| `sitemaps` | List, submit, or delete Google sitemaps; probe live URLs; read hosted snapshots (`current`, `history`, `membership`, `lastmod`, `export`) with `--site` |
| `inspect <url...> [--file]` | URL inspection for one or more URLs; renders Indexing Evidence, rich results, and AMP, and saves each result to the Store |
| `indexing` | Notify Google about URL changes (`submit`, `remove`, `status`, `batch`, `batch-status`, `quota`); supports `--retries`. `indexing urls --status not_indexed` lists hosted URL Inspection results |
| `sync` | Sync GSC data, sitemaps, and URL Inspection results to the local Store; `--inspect-limit`, `--max-calls`, `--all-sites`, `--no-sitemaps`, `--no-inspections`, `--retry-failed`, `--dry-run` |
| `query` | Run a search analytics query (Store by default; `--live` hits GSC API). Filters: `--query`, `--page`, `--country`, `--device`, `--search-appearance`, `--type`, `--data-state`, `--aggregation-type`. `--explain` previews the request body; `--output -` writes to stdout. `--sql` runs DuckDB SQL over the Store views; `--schema` lists them. |
| `dump` | Export the Store, inspections, sitemaps, and Bing data (`--format parquet\|csv\|json\|ndjson\|sqlite\|duckdb`, `--tables`, `--all-sites`, `--no-bing`). Every row has `site` and `search_type` |
| `analyze <tool>` | Run an SEO Analyzer against the Store (`--live` for row-based against fresh API) |
| `entities` | Read saved URL inspections and snapshot indexing metadata into the local entity store |
| `store stats` | Show row/byte counts per table and on-disk footprint |
| `store compact` | Compact older data into weekly, monthly, and quarterly tiers (`--dry-run`) |
| `store gc` | Delete orphaned objects past the grace window (`--dry-run`) |
| `store rm-site` / `store reset` | Delete one Site's data or reset the Store; inspect `--help` before use |
| `store rollups rebuild` | Rebuild post-sync rollup tables |
| `report <id>` / `report list` | Run or list Reports; `--explain` previews a plan |
| `profile` | Create, select, list, or delete credential profiles |
| `mcp` | Start the MCP server for AI assistants |
| `skill install [--agent claude\|codex] [--target <dir>]` | Copy the packaged `gscdump` agent skill (SKILL.md) into an agent skill directory |
| `papercut --command <cmd> --comment <text> --agent <name> [--intent bug\|improvement] --yes` | Report a CLI problem to gscdump.com; anonymous, ten per hour per network address |

## Hosted and local authentication

One authentication mode applies to both Google and Bing.
Credentials and the saved mode belong to the current `--profile` or `--config-dir`.

```bash
# Use a user API key from https://gscdump.com/app/settings
export GSCDUMP_API_KEY=gsd_user_...
gscdump auth login --mode cloud
gscdump auth status --json

# Google uses the connection on gscdump.com
gscdump sites --json
gscdump query --live --site sc-domain:example.com --dimensions page

# Connect Bing through gscdump.com, then read its data
gscdump bing sites --json
gscdump bing login --site s_SITE_ID
gscdump bing status --site s_SITE_ID --json
gscdump bing dump --site s_SITE_ID --out ./bing-export --format csv

# Use local credentials for one command
gscdump bing sites --mode local --json

# Save local mode after successful Google login
gscdump auth login --mode local
```

`--mode cloud|local` overrides the mode for one invocation.
`GSCDUMP_AUTH_MODE` provides the same override.
A successful login saves the mode for later commands.
If no mode is saved, `GSCDUMP_API_KEY` selects hosted authentication.
With neither source, the CLI defaults to local authentication.
When a saved mode exists, it remains selected unless an explicit override applies.
`GSCDUMP_API_ROOT` defaults to `https://gscdump.com/api`.
If you change a saved API root, supply the API key explicitly.

| Operation | Hosted authentication | Local authentication |
| --- | --- | --- |
| Google queries, sync, sites, sitemaps, URL inspection | Uses the Google connection through gscdump.com | Calls Google with local credentials |
| Google Indexing API and Site Verification API | Requires local mode | Supported with the required Google scopes |
| Bing datasets | Reads synced datasets through the public API | Reads data currently returned by Bing |
| Bing connection and CNAME verification | Uses `bing login`, `bing status`, and `bing verify` | Verify sites in Bing Webmaster Tools |
| Hosted sitemap membership and history | Supported | Requires hosted authentication |
| Store queries and exports | Reads the local Store | Reads the local Store |

Hosted Bing access follows the API's plan and preview access rules.
`auth logout` removes the saved mode and saved Google and Bing credentials.
Environment credentials remain active until you unset them.

## Bing

For local Bing access, generate an API key in Bing Webmaster Tools under Settings, API Access.
See [Microsoft's authentication guide](https://learn.microsoft.com/en-us/bingwebmaster/getting-access).

```bash
export BING_API_KEY=...
gscdump bing login --mode local
gscdump bing sites --json
gscdump bing dump --site https://example.com/ --format json --out ./bing-export
gscdump bing dump --all-sites --format ndjson
gscdump bing inspect https://example.com/page --site https://example.com/ --json
```

`BING_ACCESS_TOKEN` also accepts an existing Bing OAuth access token.
Local API keys and OAuth credentials are saved separately from Google credentials.
`bing logout --mode local` removes only saved Bing credentials.

For local browser OAuth, register a Bing OAuth client with this exact redirect URI:
`http://127.0.0.1:53683/oauth/bing`.

```bash
export BING_CLIENT_ID=...
export BING_CLIENT_SECRET=...
gscdump bing login --mode local --oauth
```

Use `--redirect-uri` or `BING_REDIRECT_URI` for another registered loopback URI.
`--no-browser` prints the authorization URL. Saved OAuth credentials refresh automatically.

`bing dump` exports `traffic`, `pages`, `keywords`, and `crawl` by default.
Use `--datasets traffic,pages` to select datasets.
Local mode also supports `--datasets crawl-issues`.
Files use JSON, NDJSON, or CSV, with one directory per Bing site and a `metadata.json` file.

In hosted mode, exports default to the last 366 days.
Use `--start YYYY-MM-DD --end YYYY-MM-DD` for a range up to 366 days.
The CLI follows every returned page and rejects unavailable datasets or a snapshot that changes during export.
In local mode, date options filter the rows Bing returns. They cannot recover older history.
Bing Indexing Evidence preserves uncertainty and does not imply an indexed verdict.

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

### SQL over the Store

`query --sql` runs DuckDB SQL over one view per Store table.
Run `query --schema` to list the views, their columns, and their date ranges.

```bash
gscdump query --format json --sql "
  SELECT p.page, SUM(q.clicks) AS clicks, gsc_position(q.sum_position, q.impressions) AS position
  FROM pages p JOIN page_queries q USING (site, search_type, url, date)
  WHERE p.search_type = 'web' AND p.date >= DATE '2026-08-01'
  GROUP BY p.page ORDER BY clicks DESC LIMIT 20"
```

| Column | Meaning |
| --- | --- |
| `site` | The Site URL, such as `sc-domain:example.com` |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, or `googleNews` |
| `url`, `page` | The page path. `page` is the same value as `url` |
| `sum_position` | Zero-based position multiplied by impressions |

- The Store keeps every search type. Filter or group by `search_type`, or a `SUM` adds web, image, and Discover rows together.
- `gsc_position(sum_position, impressions)` returns the impression-weighted average position. Use it with `GROUP BY`.
- The views cover every Site in the Store. `--site` and `--type` narrow them.
- Dates return as `YYYY-MM-DD`. Integers return as numbers, and an integer past 2^53 returns as a string.
- If the SQL names a table with no synced data, the CLI prints a warning.

### Export formats

`dump` reads only the Store. It never calls Google to fill a gap.
Every exported row has `site` and `search_type` columns.

| `--format` | Output |
| --- | --- |
| `parquet` (default) | `<site>/<search_type>/<table>.parquet` |
| `csv`, `json`, `ndjson` | `<site>/<search_type>/<table>.<ext>`, plus a per-row `position` |
| `sqlite` | One `gscdump.sqlite` file. Dates are `YYYY-MM-DD` text |
| `duckdb` | One `gscdump.duckdb` file |

Inspections, sitemaps, and Indexing API metadata go to `<site>/<dataset>.<ext>`, or to their own tables in a database file.
`manifest.json` lists every dataset with its row count, and the same coverage that `sync --status` reports.
`--format sqlite` needs Node.js 22.13 or later.

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
# Default: catch every table and search type up to the latest final date.
# A table with no history starts 28 days back. Newest dates come first.
# Also saves sitemaps and inspects up to 50 due URLs. Skips completed dates.
gscdump sync --site sc-domain:example.com

# Backfill the 16 months Google keeps, plus 14 days Google often still serves
gscdump sync --site sc-domain:example.com --full

# Cap one run at 2,000 Search Analytics calls; the next run continues
gscdump sync --site sc-domain:example.com --full --max-calls 2000

# Every verified Site, one after another
gscdump sync --all-sites

# Custom range
gscdump sync --site sc-domain:example.com --start 2026-08-01 --end 2026-08-31 \
  --tables pages,queries,page_queries,countries,dates

# Coverage, missing and failed dates per table, and a running sync
gscdump sync --site sc-domain:example.com --status

# Limit concurrent day requests per table
gscdump sync --site sc-domain:example.com --concurrency 4 \
  --tables pages,queries,page_queries,countries,dates
```

Sync skips completed dates; `--force` refreshes them.
A day Google still updates stays `pending`, and the next sync fetches it again.
Sync records Google calls in a quota ledger in the Store directory.
If Google refuses a call for quota, sync stops, keeps the rest `pending`, and exits 0. The next run continues.
Cross-process locks coordinate `sync`, `compact`, and `gc`.
Pagination follows Google's 25,000-row pages and stops at the first short page, subject to [Google's data limits](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data).

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

This section covers local Google credentials. See [shared authentication](#hosted-and-local-authentication) for cloud mode and [Bing](#bing) for Bing credentials.
`gscdump init --mode local` configures Google OAuth and a Store directory.
Credentials are saved under `~/.config/gscdump/` on XDG systems, or the platform equivalent.
Use `gscdump auth login --mode local` to connect Google and save local mode.

If you configure your own Google OAuth client, browser login uses a temporary listener on `127.0.0.1` with a random port.
Each attempt uses state validation and PKCE S256 to bind the authorization response to that attempt.
The listener closes after authorization, denial, or a five-minute timeout.

By default, login opens gscdump.com. No Google Cloud project is required.
The platform handles Google login and token refresh. Data queries call Google directly.
This grants read-only Search Console access. It does not activate hosted sync, storage, or hosted MCP.
Hosted Pro is free during beta and will require payment after launch.
For Google write operations, configure your own OAuth client with the required scopes.

For your own OAuth client:

1. Create a Google Cloud project.
2. Enable **Search Console API**, **Web Search Indexing API**, and **Site Verification API**.
3. Create OAuth2 credentials (Desktop app).
4. Set `GSC_CLIENT_ID` and `GSC_CLIENT_SECRET` for your Desktop app.
5. Run `gscdump auth login --mode local` to save local mode.

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
`auth login --mode local` skips OAuth when it finds BYOK credentials and saves local mode.

### Service account

For CI / headless usage, point `gscdump` at a service-account JSON key. Grant the service account access to each Site in Search Console under Settings → Users and permissions.

```bash
gscdump auth login --mode local --service-account ./gsc-sa.json   # smoke-test the key
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/gsc-sa.json
gscdump sites
```

### Headless OAuth

If you want to open the authorization URL yourself, disable automatic browser opening:

```bash
gscdump auth login --mode local --no-browser
# Open the printed URL in your browser.
```

Default login works from a remote terminal without port forwarding. Keep the command running until you approve the browser request.

With your own OAuth client, login uses the Desktop application loopback flow.

If the CLI runs on another host, forward its printed loopback port before opening the URL.
Keep the login command running on that host.
For example, if the CLI prints port `45678`, run this command on your browser host:

```bash
ssh -N -L 45678:127.0.0.1:45678 user@host
```

Replace `user@host` with the CLI host.
Keep the forwarding command running until login completes.
Then open the printed authorization URL in your browser.
For containers or WSL, forward the same port to the environment running the CLI.
If you cannot forward loopback traffic, use a refresh token or service account.

See Google's [native application OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app)
and [device flow scope limits](https://developers.google.com/identity/protocols/oauth2/limited-input-device#allowedscopes).

Indexing notifications apply only to eligible job or livestream pages.
See [URL inspection and indexing](../../docs/guides/url-indexing.md).

## Related

- [`gscdump`](../gscdump) : Google and Bing clients with a typed query builder.
- [`@gscdump/engine`](../engine) : Storage engine the CLI syncs into.
- [`@gscdump/analysis`](../analysis) : SEO Analyzers (row-based + DuckDB-native).

## License

[MIT](../../LICENSE)

## CLI charts

Human output shares chart styles and metric units across Analyzers, Reports, and Store stats.
Use `gscdump query --format table` for query charts.
JSON and CSV keep their existing payloads and defaults.
See [CLI charts](../../docs/guides/cli-charts.md) for examples and data limits.
