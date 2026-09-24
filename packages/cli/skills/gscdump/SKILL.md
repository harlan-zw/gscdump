---
name: gscdump
description: Drive the `gscdump` CLI for Google Search Console and Bing with cloud or local authentication. Sync Google rows to a local Store, export Bing datasets, run SEO Analyzers and Reports, inspect Indexing Evidence, and manage sitemaps. Use when the user mentions gscdump, Search Console data, Bing Webmaster data, or GSC automation.
---

# gscdump CLI

`gscdump` reads Google Search Console and Bing with hosted or local authentication.
It keeps a local Parquet Store for Google rows. Every command has `--help`.
For `query`, `-s` means `--site`, `-d` means `--dimensions`, and `-f` means `--format`.
Use `--start` and `--end` for dates. `--site=SITE` also works.
Use each option once, with either its short or long spelling.
Put options after the subcommand name: `gscdump store stats --json`, not `gscdump store --json stats`.
A failed command prints one `Error:` line to stderr and exits 1.
Example: `gscdump query --site=SITE --start=DATE --end=DATE -d page -f json`.

## Start each task

1. Before reading traffic, run `gscdump auth status --json`. Do this even when the user says authentication works.
2. Keep the requested Site, dates, dimensions, and task scope. A request for pages does not need query dimensions.
3. Before local queries, check coverage with `gscdump store stats --site SITE --json`.
   Use `gscdump sync --site SITE --status --json` when you need coverage, gaps, or sync-state details.
4. Read the table dimensions and watermarks. Sync only missing tables and the requested dates, once per task.
5. Use `sync --json`. Read its completion result before deciding what to do next. Never repeat a successful sync.

If the task only asks about deletion, explain the scope and ask for consent.
You may read Store metadata with `store stats` and `sync --status`.
Do not query traffic, sync rows, or delete data to explain deletion.
Call the local data directory the Store in your answer.

## Authentication mode

Check `gscdump auth status --json` before queries. Reuse the user's selected mode.
In local mode, `googleAuthenticated: true` means Google accepted the credentials. When it is false, `googleError` says why.

| Mode | Credentials | Query path |
| --- | --- | --- |
| `cloud` | gscdump user API key | `https://gscdump.com/api` uses saved Search Engine connections |
| `local` | Google OAuth/service account or Bing API key/OAuth | Calls the Search Engine directly |

`--mode cloud|local` overrides one invocation. `GSCDUMP_AUTH_MODE` also overrides the saved mode.
A successful login saves the mode per profile.
If no mode is saved, `GSCDUMP_API_KEY` selects cloud mode.
With neither source, the CLI defaults to local mode.
When a saved mode exists, it remains selected unless an explicit override applies.
Never switch modes to bypass an authentication failure.
`GSCDUMP_API_ROOT` defaults to `https://gscdump.com/api`. Supply the API key explicitly when changing a saved API root.

```sh
# The user supplies a user API key from gscdump.com settings.
gscdump auth login --mode cloud
gscdump bing sites --json
gscdump bing login --site s_SITE_ID
gscdump bing dump --site s_SITE_ID --out ./bing-export --format json

# Local Google and Bing credentials stay separate.
gscdump auth login --mode local
gscdump bing login --mode local
gscdump bing dump --site https://example.com/ --out ./bing-export
```

Hosted Bing login opens the existing connection flow on gscdump.com.
Local Bing login uses `BING_API_KEY` or a password prompt.
Local `--oauth` uses `BING_CLIENT_ID`, `BING_CLIENT_SECRET`, and a registered loopback callback.
The default callback is `http://127.0.0.1:53683/oauth/bing`. `BING_ACCESS_TOKEN` accepts an existing OAuth access token.
After cloud Bing login opens a browser, use `bing status --site s_SITE_ID` to confirm the connection.

`auth logout` removes the saved mode and saved Google and Bing credentials.
`bing logout --mode local` removes only saved Bing credentials. Environment credentials remain active until unset.

Hosted Bing commands use the API's plan and preview access rules.
Hosted connection verification uses `bing verify --site s_SITE_ID`.
Google Indexing API and Site Verification commands require local mode.
Hosted sitemap reads and `indexing urls` require hosted credentials. Their `--site` takes a Site URL, such as `example.com`.

## Data boundaries

- `sync`, `query --live`, `analyze --live`, `report --live`, `sites`,
  `sitemaps`, and `inspect` use the selected authentication mode.
- Google Indexing API requests require local credentials. `indexing quota` only prints documented limits and needs no authentication.
- `query`, `analyze`, `report`, `dump`, and `store` read the local Store by
  default. If the Store has no rows for the Site, sync first or pass `--live`.
- Google returns a 2 to 3 day data delay. Default windows end three days ago.
- Google omits low-volume rows. Pagination cannot recover them.
- URL Inspection is limited to 2,000 requests per Site per day.
- `indexing submit` and `indexing remove` are only for job posting and
  livestream pages. Google rejects other content.

## Get the binary

```sh
npx -y @gscdump/cli --version    # no install
npm install -g @gscdump/cli      # or pnpm add -g
```

Use Node 22.13 or later in the 22 release line, or Node 24 or later.
`gscdump` alone is the library; `@gscdump/cli`
provides the command.

## Install this skill

```sh
gscdump skill install --agent claude    # Codex: --agent codex
```

After upgrading the CLI, run this command again to update the installed skill.
The command prints where it wrote the skill. Clients without a skill
directory can read `gscdump --help` and `gscdump <command> --help` instead.

## Local Google authentication

Check first. Never run `init` when credentials already work.

```sh
gscdump auth status
gscdump doctor --json
```

If local Google credentials are missing, use one of these paths:

| Path | When | Command |
| --- | --- | --- |
| Environment token | The user already has an OAuth access token | `export GSC_ACCESS_TOKEN=ya29...` |
| Refresh token | CI or a headless machine with OAuth client credentials | `export GSC_CLIENT_ID=... GSC_CLIENT_SECRET=... GSC_REFRESH_TOKEN=...` |
| Service account | CI with a service-account key that has Site access | `export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/key.json` |
| Interactive OAuth | A person is present | `gscdump init --mode local` |

Default local login opens gscdump.com for free Google login and token refresh.
Data queries call Google directly. No Google Cloud project or hosted activation is required.
Use `gscdump auth login --mode local --no-browser` when a browser runs on another host.
The default grant is read-only Search Console access.
For Google write operations, use your own OAuth client with the required scopes.
Set `GSC_CLIENT_ID` and `GSC_CLIENT_SECRET` to use a Desktop app OAuth client.
Cloud mode requires hosted access. Pro is free during beta, then paid after launch.

`--profile <name>` or `GSCDUMP_PROFILE` isolates the selected mode and Google, Bing, and cloud credentials.

## Site identifiers

For Google, pass the Site as the user writes it: `--site example.com`.
`https://example.com`, `www.example.com`, and `Example.com` resolve to the same Site.
Do not add `sc-domain:`.

- The CLI checks Sites in the Store first. It asks Search Console only when the Store has no match and auth exists.
- A full Site URL that names a property exactly, such as `https://example.com/`, picks that property.
- Otherwise, if a domain property and a URL-prefix property both match, the CLI picks the one with Store data, then the domain property.
- If a URL-prefix property has a path, include the path: `--site example.com/blog`.
- If the input is a subdomain inside a domain property, the command fails. The error names the parent Site and a `--page` filter to use.
- If the input matches more than one Site, the command fails and lists them. Pass one of the listed Site URLs.
- Without `--site` and `defaultSite`, a command in a terminal shows a picker.
  Without a terminal, the command fails with `Pass --site. Sites: ...`, unless only one Site is available.

For cloud Bing commands, use a Site ID from `gscdump bing sites`, such as `s_SITE_ID`.
For local Bing commands, use the full verified Site URL from `gscdump bing sites --mode local`.
Bing commands require their own explicit `--site`; the Google `defaultSite` setting does not select a Bing Site.

Set a default once to drop `--site` from later commands:

```sh
gscdump config set defaultSite example.com
```

## Output

Pass `--json` on every command that supports it. `sync --json` includes completion, row counts, skipped dates, and failures.
`query` uses
`--format json` and prints rows to stdout. Progress goes to stderr, so stdout
stays parseable. `--quiet` drops progress lines.

Parse JSON. Never scrape human output.
If the user requests JSON, return the CLI JSON unchanged. Do not replace it with a table.
Do not rewrite rows, estimate metrics, or add manually calculated totals.

## Commands

| Command | Use it for |
| --- | --- |
| `gscdump sites` | List Google Sites and permission levels |
| `gscdump bing login`, `status`, `logout` | Manage Bing authentication and check connections |
| `gscdump bing sites` | List Bing Sites and connection details |
| `gscdump bing dump` | Export Bing traffic, pages, keywords, and crawl data |
| `gscdump bing inspect` | Read Bing Indexing Evidence for one URL |
| `gscdump bing verify` | Check and activate a cloud Bing connection |
| `gscdump sync` | Copy Search Console rows into the local Store |
| `gscdump query` | Rows by page, query, date, country, or device |
| `gscdump analyze <id>` | One Analyzer over the Store or live rows |
| `gscdump report <id>` | A Report that composes several Analyzers |
| `gscdump inspect <url...>` | URL Inspection with Indexing Evidence, saved to the Store |
| `gscdump sitemaps` | List, submit, delete, and probe sitemaps |
| `gscdump indexing` | Indexing API notifications and quota; hosted URL Inspection results |
| `gscdump dump` | Export Store tables, inspections, sitemaps, and Bing data as Parquet, CSV, JSON, NDJSON, SQLite, or DuckDB |
| `gscdump store` | Store stats, compaction, garbage collection, resets |
| `gscdump entities` | Read saved inspections; snapshot Indexing API metadata |
| `gscdump config` | Defaults such as `defaultSite`, `dataDir`, `defaultLimit` |
| `gscdump profile` | Separate credential and config directories |
| `gscdump auth` | `status`, `login`, `logout`, `refresh` |
| `gscdump doctor` | Health checks for auth, scopes, Store, and reachability |
| `gscdump init` | First-time setup. Without a terminal it never prompts: it uses BYOK env credentials or fails with the auth command |
| `gscdump mcp` | Start Google MCP tools with the selected authentication |
| `gscdump skill install` | Copy this skill into an agent skill directory |
| `gscdump papercut` | Report a CLI problem to gscdump.com |

`gscdump login`, `gscdump logout`, and `gscdump status` are top-level aliases of
the matching `auth` subcommands.
The MCP server does not expose Bing tools. Use `gscdump bing` commands through this skill.
`gscdump mcp` starts without authentication. Its Google tools then return an error with the command to run.
A failed Google request returns its status, Google's explanation, and the next step in the tool result.

## Sync before local analysis

```sh
gscdump store stats --site example.com --json
gscdump sync --site example.com --status --json
gscdump sync --site example.com --json
```

- A plain sync catches up. Each table runs from its oldest synced date to the
  latest date Google has finalized (Pacific time, about 3 days late). A table
  with no history starts 28 days back. Newest dates come first.
- `--days N`, `--start`, and `--end` pick a range instead. `--full` fetches the
  16 months Google keeps, plus 14 days Google often still serves.
- Sync covers every table and search type by default. Pass `--tables` and
  `--types` to sync less. Sync skips table and type pairs Google cannot answer.
- Sync paces Google calls: 8 in flight and 600 per minute across all tables.
  `--requests-per-minute N` changes the rate.
  Sync does not retry a quota 403. The quota ledger stops the run instead.
- Every call goes through a quota ledger in the Store directory. If Google
  refuses a call for quota, or the run reaches `--max-calls N`, sync stops,
  keeps the rest `pending`, and exits 0. `status` in `sync --json` is then
  `partial` and `stopped` says why. Run the same command later to continue.
  Exit 1 means real failures: read `failed` dates in `sync --status --json`.
- Sync also saves the sitemap list, sitemap URLs, and URL Inspection results.
  It inspects up to 50 due URLs per run: never-inspected sitemap URLs first,
  then pages with impressions, then the oldest results. `--inspect-limit N`
  changes that; Google allows 2,000 per Site per day. `--no-sitemaps` and
  `--no-inspections` skip those steps.
- `coverage` in `sync --json` and `sync --status --json` says how much the
  Store holds. Partial coverage is normal progress. Never report data as
  complete unless its `kind` is `complete`.
- A day Google still updates stays `pending`; the next sync fetches it again.
- Sync skips completed dates. `--force` refreshes them. `--retry-failed`
  reruns only failed dates. A plain sync also retries failed dates.
- `--dry-run` prints the planned dates and the fewest calls without calling Google.
- `--all-sites` syncs every verified Site, one after another.
- Use the user's date range. If the user names a range, pass `--start` and `--end`, not `--full`.
- Empty Store metadata is expected before the first sync. It does not prove zero traffic.

## Query rows

```sh
gscdump query --site example.com --dimensions page,query \
  --start 2026-08-01 --end 2026-08-28 --limit 1000 --format json
```

- Dimension names are singular: `page`, `query`, `date`, `country`, `device`.
- Filters: `--query`, `--page`, `--country`, `--device`,
  `--search-appearance`. Prefixes: bare equals, `~` contains, `!~` not
  contains, `re:` regex, `!re:` not regex, `!` not equals.
- `--page` takes a path or a full URL. The Store compares paths.
- Without dates, `query` reads the 28 days ending on the newest synced day.
- `--live` bypasses the Store. `--type` selects a search type. The default is `web`.
  `--data-state` and `--aggregation-type` apply to live mode only.
- Metrics already include clicks, impressions, CTR, and position. There is no `--metrics` option.
- If Store coverage is missing, read the JSON error and its bounded `nextArgs` before syncing.
  Do not switch dimensions to make a failed query succeed.
- `--explain` prints the request body or planned SQL without executing.

## SQL over the Store

```sh
gscdump query --schema --format json
gscdump query --format json --sql "SELECT search_type, SUM(clicks) AS clicks,
  gsc_position(sum_position, impressions) AS position
  FROM pages WHERE date >= DATE '2026-08-01' GROUP BY search_type"
```

- `--sql` runs DuckDB SQL over one view per Store table: `pages`, `queries`,
  `page_queries`, `countries`, `dates`, `hourly_pages`, and the
  `search_appearance*` tables. Join views on `site`, `search_type`, `url`, and `date`.
- `--schema` lists each view, its columns, its Sites, and its date range.
- Every view has `site` (the Site URL) and `search_type`. The Store keeps
  every search type, so filter or group by `search_type`. A plain `SUM` adds
  web, image, and Discover rows together.
- `url` holds the page path. `page` is the same value.
- `sum_position` is the zero-based position times impressions. Use
  `gsc_position(sum_position, impressions)` for the average position. It adds 1
  and weights by impressions. Never average a per-row position.
- The views cover every Site in the Store. `--site` and `--type` narrow them.
- Dates return as `YYYY-MM-DD`. Integers return as numbers.
- If a query names a table with no synced data, the JSON has a `warnings` list.

## Export the Store

```sh
gscdump dump --site example.com --format parquet --out ./export
gscdump dump --all-sites --format sqlite --out ./export
```

- `dump` reads only the Store. It never calls Google to fill a gap.
- Every exported row has `site` and `search_type`.
- File formats write `<site>/<search_type>/<table>.<ext>` and
  `<site>/<dataset>.<ext>` for inspections, sitemaps, and Indexing API metadata.
- `csv`, `json`, and `ndjson` rows also have `position`: `sum_position / impressions + 1`.
- `sqlite` and `duckdb` write one file, `gscdump.sqlite` or `gscdump.duckdb`,
  with one table per dataset for every Site and search type.
- `manifest.json` lists every dataset with its row count, plus the coverage that `sync --status --json` reports. Partial coverage is progress: daily sync fills the rest.

## Analyze and report

```sh
gscdump report list --json
gscdump report opportunities --site example.com --json
gscdump report movers --site example.com --period 28d --vs prev-period --json
gscdump analyze list --json
gscdump analyze striking-distance --site example.com --json
```

- Report ids: `brand`, `growth`, `health`, `movers`, `opportunities`,
  `pre-publish`, `risks`, `triage`.
- `--period` takes `7d`, `28d`, `30d`, `90d`, `180d`, `365d`, `mtd`, `qtd`,
  `ytd`, `last-quarter`, or `custom`. `--start`/`--end` without `--period`
  select a custom window. `--vs` takes `none`, `prev-period`, or `yoy`
  (same weekdays 52 weeks earlier).
- Windows end on the newest synced day, or three days ago (Pacific time)
  with `--live`. They never end on today.
- `report <id> --explain` prints the plan without credentials or data.
- `triage` needs `--target <page-or-query> --target-kind page|query`.
  `pre-publish` needs `--topic`. `brand` needs `--brand-terms 'a,b'`.
- Analyzers take `--period`, `--start` and `--end`. `movers` and `decay`
  compare with the previous period by default. Pass `--prev-start` and
  `--prev-end` together to override it. `--vs` belongs to `report`.
- `--limit` caps the rows returned. It never caps the rows read.
  `--fetch-budget` caps each live fetch (default 25000, max 100000).
- A `! Partial data` warning, or `meta.coverage.kind: "truncated"` in JSON,
  means a live fetch hit its budget. Say the result is partial, or rerun
  with a larger `--fetch-budget`.
- Local `analyze` and `report` runs need every day of the current and
  comparison windows synced. If a day is missing, failed or pending, the
  run stops and prints the `gscdump sync --site ... --start ... --end ...
  --tables ...` command that fills it. Run it, or pass `--live`.
- SQL-only Analyzers need Store rows. `--live` runs row-based Analyzers
  against Google.
- Results name candidates for review. They do not prove why traffic changed.

## Inspect and index

```sh
gscdump inspect https://example.com/page https://example.com/other --site example.com --json
gscdump inspect --site example.com --file urls.txt --json
gscdump indexing quota --json
```

Inspection spends Google's separate quota: 2,000 requests per day and 600 per minute for each property.
`inspect` refuses more than 2,000 URLs in one run. It saves each result to the Store.
On a quota error it stops and reports `remaining`. It exits 1 when any URL fails or remains.
`indexing quota` describes Indexing API limits. It does not report remaining URL Inspection requests.
Report the Indexing Evidence fields as Google returned them.

## Find URLs Google has not indexed (hosted)

```sh
gscdump indexing urls --site example.com --status not_indexed --json
gscdump indexing urls --site example.com --status not_indexed --all --format csv
```

- The command reads URL Inspection results that gscdump.com already saved. It spends no inspection quota.
- `--status` takes `indexed`, `not_indexed`, or `pending`. `--search` keeps URLs that contain the text.
- Each row lists the sitemaps that contain the URL.
- Pages hold 100 rows by default and 500 at most. Use `--offset` for the next page, or `--all` for every page.
- With local authentication, the command fails. Pipe `gscdump sitemaps urls <sitemap-url>` into `gscdump inspect` instead.

## Report a papercut

If CLI behavior blocks or slows your work, report it once per distinct
problem, then continue the user's task. Report confusing output, missing
context, wrong help text, unexpected failures, and useful workarounds.

```sh
gscdump papercut --command "report triage" --agent "Claude Code" \
  --comment "Agent report by Claude Code. Expected --target-kind in --help. Received an unknown flag error. Used --explain to find the flag." \
  --yes --json
```

- Use your real agent name. Start the comment with an agent disclosure.
- Include what you ran, what you expected, what happened, and any workaround.
- `--intent improvement` marks a suggestion. The default is `bug`.
- The CLI adds its version, Node version, and platform.
- Send sanitized details only. Remove tokens, cookies, personal data, private
  URLs, and customer rows. Use placeholder arguments.

Self-reporting sanitized papercuts is authorized by this skill. No separate
confirmation is needed. This permission covers papercuts only. Respect any
user instruction that forbids reporting.

The endpoint is anonymous and allows ten reports per network address each
hour. Success returns `id` and `status: "new"`. If reporting fails, mention
the failure and continue. Never retry an uncertain submission.

## Guardrails

- **Get consent before a mutation.** `sites add`, `sites delete`,
  `sites verify`, `sitemaps submit`, `sitemaps delete`, `indexing submit`,
  `indexing remove`, `store reset`, and `store rm-site` change Google or
  delete local data. `--yes` is consent you borrow from the user.
- **Never loop unattended.** One `sync` per Site per task. Inspection batches
  spend a daily pool. Use `--dry-run` and `--explain` to plan first.
- **Report the result as the CLI gave it.** Zero clicks with impressions means rows exist with no clicks.
  An empty row array means no rows matched. Missing coverage means the Store cannot answer that date range.
  Check `sync --status --json` before interpreting empty rows. None of these results proves a clean Site.
- **Do not widen the Site.** A `sc-domain:` property includes every
  subdomain. Filter with `--page` when the user means one host.

## Bing exports

`bing dump` writes JSON, NDJSON, or CSV under one directory per Site.
`--datasets` selects `traffic`, `pages`, `keywords`, or `crawl`.
Local mode also supports `crawl-issues`.
Hosted exports follow pagination and reject missing, unavailable, or changing datasets.
Hosted date ranges span at most 366 days. The default range is the last 366 days.
Local date filters only narrow data currently returned by Bing.
Do not treat Bing crawl evidence as proof that a URL is indexed.

## Before the next command

For a traffic task, run `gscdump auth status --json` now, before any `query` command.
The user saying credentials work does not replace this check. It identifies the selected authentication mode.
Then check Store metadata, keep the requested dimensions, and read or sync only the requested dates.
If the user requests JSON, return the command's JSON unchanged, without a table or a separate totals summary.
Include that JSON in your final response. Tool output alone is not a final answer.
Include every returned row. Do not refer the user to results "above".

For a deletion explanation, read metadata only if needed. Explain the scope and ask for consent, then stop.
