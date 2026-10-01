---
name: gscdump
description: Drive the `gscdump` CLI for Google Search Console and Bing in Local or Hosted mode. Sync Google rows to a local Store, export Bing datasets, run SEO Analyzers and Reports, inspect Indexing Evidence, and manage sitemaps. Use when the user mentions gscdump, Search Console data, Bing Webmaster data, or GSC automation.
---

# gscdump CLI

`gscdump` reads Google Search Console and Bing in one of 2 access modes: Local or Hosted.
In Local mode it keeps a local Parquet Store for Google rows. Every command has `--help`.
For `query`, `-s` means `--site`, `-d` means `--dimensions`, and `-f` means `--format`.
Use `--start` and `--end` for dates. `--site=SITE` also works.
Use each option once, with either its short or long spelling.
Put options after the subcommand name: `gscdump store stats --json`, not `gscdump store --json stats`.
A failed command prints one `Error:` line to stderr and exits 1. With JSON output it also prints `{ "error" }` on stdout. See [Stops](#stops).
Example: `gscdump query --site=SITE --start=DATE --end=DATE -d page -f json`.

## Start each task

1. Before reading traffic, run `gscdump auth status --json`. Do this even when the user says authentication works.
2. Keep the requested Site, dates, dimensions, and task scope. A request for pages does not need query dimensions.
3. In Hosted mode, skip steps 3 to 5. `gscdump query` reads the hosted record, and `sync` needs Local mode.
   Before Local queries, check coverage with `gscdump store stats --site SITE --json`.
   Use `gscdump sync --site SITE --status --json` when you need coverage, gaps, or sync-state details.
   On a fresh Store, `store stats` exits 1 and says it has no data. Continue with the bounded sync.
4. Read the table dimensions and watermarks. Sync only missing tables and the requested dates, once per task.
5. Use `sync --json`. Read its completion result before deciding what to do next. Never repeat a successful sync.
6. If the user asks for saved rows, check `meta.source` in the query result: `local` (the Store) or `hosted` (the hosted record). In Local mode, a successful query can answer `live` when its table has no synced data.

If the task only asks about deletion, explain the scope and ask for consent.
You may read Store metadata with `store stats` and `sync --status`.
Do not query traffic, sync rows, or delete data to explain deletion.
Call the local data directory the Store in your answer.

## Access mode

gscdump has 2 access modes. Check `gscdump auth status --json` before queries. Reuse the user's selected mode.

| Mode | Credentials | What it reads |
| --- | --- | --- |
| `local` | The user's own Google credentials: a service account (recommended) or an OAuth client. Bing API key or OAuth | Calls Google and Bing directly. Keeps a local Store |
| `hosted` | A browser-approved gscdump.com CLI session, or a gscdump user API key (`GSCDUMP_API_KEY`) | Reads the hosted record on gscdump.com. Never calls Google |

In Local mode, `googleAuthenticated: true` means Google accepted the credentials. When it is false, `googleError` says why.
In Hosted mode, `hostedSync` lists each hosted Site with `syncStatus` and `syncProgress`, and `commands` lists what Hosted mode can run.
`gscdump sites` shows the same Sites and progress.
An empty `sites` list means the hosted record has no Sites. Commands that need a Site then stop with `NO_SITES`.
Tell the user to connect a Site. A browser login connects Sites on gscdump.com.
An API key connects Sites in the app that issued the key. That app can be a partner app, not gscdump.com.

`--mode local|hosted` overrides one invocation. `GSCDUMP_AUTH_MODE` also overrides the saved mode.
A successful login saves the mode per profile.
If no mode is saved, `GSCDUMP_API_KEY` selects Hosted mode.
With neither source, the CLI uses Local mode.
When a saved mode exists, it remains selected unless an explicit override applies.
Never switch modes to bypass an authentication failure.
`GSCDUMP_API_ROOT` defaults to `https://gscdump.com/api`. Browser login uses this root. Supply an API key explicitly for a custom root.

```sh
# Local mode, recommended: a service account never expires.
gscdump auth login --mode local --service-account ./key.json

# Local mode with your own OAuth client.
export GSC_CLIENT_ID=your-client-id GSC_CLIENT_SECRET=your-client-secret
gscdump auth login --mode local

# Hosted mode: open gscdump.com in a browser and approve the CLI session.
gscdump auth login --mode hosted
gscdump sites --json
gscdump query --site example.com -d page -f json
```

Hosted mode can run only these commands: `sites`, `query`, `sitemaps current`, `sitemaps history`, `sitemaps membership`,
`sitemaps lastmod`, `sitemaps export`, `indexing urls`, `indexing summary`, `indexing watch list|add|remove`,
and the `bing` commands `login --site`, `sites`, `status`, `dump`, `inspect`, and `verify`.
Every other command calls Google, so it needs Local mode: `sync`, `inspect`, `query --live`, `analyze --live`, `report --live`,
`sites add|get|delete|verify*`, `sitemaps list|get|submit|delete`, `indexing submit|remove|status|batch`, `entities`, and `mcp`.
In Hosted mode these commands stop with this error: `This command calls Google, so it needs Local mode.`
Tell the user. Do not switch modes for them.
For an MCP client in Hosted mode, use the gscdump.com MCP server at `https://gscdump.com/mcp`.

Hosted Bing login opens the existing connection flow on gscdump.com.
Local Bing login uses `BING_API_KEY` or a password prompt.
Local `--oauth` uses `BING_CLIENT_ID`, `BING_CLIENT_SECRET`, and a registered loopback callback.
The default callback is `http://127.0.0.1:53683/oauth/bing`. `BING_ACCESS_TOKEN` accepts an existing OAuth access token.
After Hosted Bing login opens a browser, use `bing status --site s_SITE_ID` to confirm the connection.

```sh
gscdump bing sites --json
gscdump bing login --site s_SITE_ID
gscdump bing dump --site s_SITE_ID --out ./bing-export --format json
gscdump bing login --mode local
gscdump bing dump --site https://example.com/ --out ./bing-export
```

`auth logout` revokes a saved Hosted CLI session and removes saved mode and Google and Bing credentials.
`bing logout --mode local` removes only saved Bing credentials. Environment credentials remain active until unset.

Hosted Bing commands use the API's access rules.
Hosted connection verification uses `bing verify --site s_SITE_ID`.
Hosted sitemap reads and the hosted `indexing` commands need Hosted mode. Their `--site` takes a Site URL, such as `example.com`.

## Data boundaries

- `sync`, `query --live`, `analyze --live`, `report --live`, `inspect`, and Google sitemap and Site changes call Google. They need Local mode.
- In Hosted mode, `sites` and `query` read the hosted record. They never call Google.
- Google Indexing API requests need Local mode. `indexing quota` only prints documented limits and needs no authentication.
- `dump` and `store` read the local Store only.
- `query`, `analyze`, and `report` pick a source for each run. See [Routing](#routing).
- Google returns a 2 to 3 day data delay. Default windows end three days ago.
- Google omits low-volume rows. Pagination cannot recover them.
- URL Inspection is limited to 2,000 requests per Site per day.
- `indexing submit` and `indexing remove` are only for job posting and
  livestream pages. Google rejects other content.

## Routing

This section covers Local mode. In Hosted mode, `query` always reads the hosted record, and JSON has `meta.source: "hosted"`.
`analyze` and `report` read the Store only in Hosted mode. When the Store cannot answer, they stop with the Local mode command.

`query`, `analyze`, and `report` choose one source for each run. One run never
mixes Store rows and live rows.

| Store data for the Site | Google connected | Result |
|---|---|---|
| Covers every date the run needs | any | Answers from the Store, also while a sync runs |
| None for the tables the run needs | yes | Answers from the live API. stderr says so, and JSON has `meta.source: "live"` |
| None | no | Stops. Next command: `gscdump init` |
| Some dates missing | yes | Stops with the exact `gscdump sync` command, or pass `--live` |
| Some dates missing, a sync is running | yes | Stops with `Sync running: 41 of 90 days done.` Run again later, or pass `--live` |

- `--live` always asks Search Console. It needs Local mode with Google credentials.
- `query --sql` reads the Store only. It stops when no table it names has data.
- JSON output carries `meta.source`: `local`, `live`, or `hosted`.
- A failure with JSON output prints `{ "error" }` on stdout and exits 1. See [Stops](#stops).
  Partial coverage and a running sync are normal progress. Run `nextCommand`, or tell the user to.
- A sync is running only while its heartbeat is recent. A killed sync does not block reads.
- Every Search Analytics, URL Inspection, and Indexing API call spends the shared quota ledger in the data dir.
  When a quota is spent, the command stops at once and says when the quota resets.

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
The command prints where it wrote the skill, as a path that works from any directory, such as `~/.claude/skills/gscdump`.
With `--json`, `destination` is the absolute path. Clients without a skill
directory can read `gscdump --help` and `gscdump <command> --help` instead.

## Local mode setup

Check first. Never run `init` when credentials already work.

```sh
gscdump auth status
gscdump doctor --json
```

If Google credentials are missing, the CLI prints both setup paths. Use one of these:

| Path | When | Command |
| --- | --- | --- |
| Service account (recommended) | Any machine. The key never expires | `gscdump auth login --mode local --service-account ./key.json`, or `export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/key.json` |
| OAuth client | A person is present and has a Google Cloud OAuth client | `export GSC_CLIENT_ID=... GSC_CLIENT_SECRET=...`, then `gscdump auth login --mode local` |
| Refresh token | CI with OAuth client credentials | `export GSC_CLIENT_ID=... GSC_CLIENT_SECRET=... GSC_REFRESH_TOKEN=...` |
| Access token | The user already has an OAuth access token | `export GSC_ACCESS_TOKEN=ya29...` |
| Hosted mode | The user has a gscdump.com account and wants the hosted record | `gscdump auth login --mode hosted` |

A service account needs Search Console access. Add its email as a user of the Site in Search Console, under Settings > Users and permissions.
An OAuth client in the Google "Testing" publishing status gets refresh tokens that expire after 7 days.
To avoid this, set the OAuth consent screen to "In production". A service account has no such limit.
Local mode never uses gscdump.com for Google login or token refresh.
Use `gscdump auth login --mode local --no-browser` when a browser runs on another host.
A service account or an OAuth client with the required scopes also enables Google write operations.

`--profile <name>` or `GSCDUMP_PROFILE` isolates the selected mode and its Google, Bing, and Hosted credentials.

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

For Hosted Bing commands, use a Site ID from `gscdump bing sites`, such as `s_SITE_ID`.
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

## Stops

A stop ends a command at a known condition and exits 1. stderr gets the message.
If the command writes JSON, every failure prints `{ "error": { "code", "message", "nextCommand" } }` on stdout. A stop has a code from the table below.
Any other failure has the code `FAILED`, such as a network or API error, or `UNEXPECTED`, a defect in the CLI.
A command writes JSON with `--json`, with `--format json`, and for `query` with its default format.
If a command printed its JSON result before it failed, such as `inspect` after a quota stop, stdout holds only that result.
Read `code`, not the message. If `nextCommand` is not null, run it, or tell the user to run it.
A `gscdump auth login` command needs the user. Tell the user to run it. If `nextCommand` is null, tell the user the `message`.
A routing stop also has `siteUrl`. `STORE_RANGE_NOT_COVERED` adds `missingDates`, and `SYNC_RUNNING` adds `sync.done` and `sync.total`.

| Code | Meaning |
| --- | --- |
| `USAGE` | The command line is wrong: an unknown command or option, or a value the option does not accept. Fix it with the command's `--help` |
| `NOT_CONNECTED` | The Store cannot answer, and Google is not connected |
| `STORE_RANGE_NOT_COVERED` | The Store does not have `missingDates` |
| `SYNC_RUNNING` | A sync is still filling the dates |
| `NO_SYNCED_DATA` | A Store-only read found no synced data |
| `STORE_ONLY` | The read needs the Store, so `--live` cannot run it |
| `LIVE_ONLY` | Only `--live` can answer the read |
| `LOGIN_CANCELLED` | The user selected Cancel on the gscdump.com login page. Ask before you run `nextCommand` |
| `LOCAL_MODE_REQUIRED` | The command calls Google, and Hosted mode is selected |
| `HOSTED_MODE_REQUIRED` | The command reads the hosted record, and Local mode is selected |
| `HOSTED_CREDENTIALS_MISSING` | Hosted mode has no CLI session and no API key |
| `HOSTED_CREDENTIALS_REJECTED` | gscdump.com rejected the CLI session or API key. For an API key, `nextCommand` is null: the user needs a new key from the app that issued it |
| `NO_SITES` | The hosted record has no Sites. The message says where the user connects one |
| `SITE_NOT_FOUND` | No hosted Site matches `--site` |
| `SITE_AMBIGUOUS` | More than one hosted Site matches `--site` |
| `SITE_REQUIRED` | The hosted record has more than one Site. Pass `--site` |
| `BING_NOT_CONNECTED` | The Site has no hosted Bing connection |
| `RECORD_NOT_READY` | gscdump has not prepared the Site's record for reads yet |
| `RANGE_NOT_SYNCED` | The hosted record does not hold the requested dates |
| `QUOTA_USED_UP` | A Google API quota is used up. The message says when it resets |

## Commands

| Command | Use it for |
| --- | --- |
| `gscdump sites` | Local mode: list Google Sites and permission levels. Hosted mode: list hosted Sites and sync state |
| `gscdump bing login`, `status`, `logout` | Manage Bing authentication and check connections |
| `gscdump bing sites` | List Bing Sites and connection details |
| `gscdump bing dump` | Export Bing traffic, pages, keywords, and crawl data |
| `gscdump bing inspect` | Read Bing Indexing Evidence for one URL |
| `gscdump bing verify` | Check and activate a Hosted Bing connection |
| `gscdump sync` | Copy Search Console rows into the local Store |
| `gscdump query` | Rows by page, query, date, country, or device, from the Store or the hosted record |
| `gscdump analyze <id>` | One Analyzer over the Store or live rows |
| `gscdump report <id>` | A Report that composes several Analyzers |
| `gscdump inspect <url...>` | URL Inspection with Indexing Evidence, saved to the Store |
| `gscdump sitemaps` | List, submit, delete, and probe sitemaps |
| `gscdump indexing` | Indexing API notifications and quota; hosted URL Inspection results |
| `gscdump indexing summary` | Hosted: the coverage ladder per day, with the time gscdump counted the verdicts |
| `gscdump indexing watch` | Hosted: list, add, and remove Watched URLs and read their Checkpoints |
| `gscdump dump` | Export Store tables, inspections, sitemaps, and Bing data as Parquet, CSV, JSON, NDJSON, SQLite, or DuckDB |
| `gscdump store` | Store stats, compaction, garbage collection, resets |
| `gscdump entities` | Read saved inspections; snapshot Indexing API metadata |
| `gscdump config` | Defaults such as `defaultSite`, `dataDir`, `defaultLimit` |
| `gscdump profile` | Separate credential and config directories |
| `gscdump auth` | `status`, `login`, `logout`, `refresh` |
| `gscdump doctor` | Health checks for auth, scopes, Store, and reachability |
| `gscdump init` | First-time setup. Without a terminal it never prompts: it uses a service account or environment credentials, or fails with both setup paths |
| `gscdump mcp` | Start Google MCP tools in Local mode. Hosted mode uses `https://gscdump.com/mcp` |
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
- If the user excludes rollups, pass `--no-rollups` on the sync command.
- Empty Store metadata is expected before the first sync. It does not prove zero traffic.

## Query rows

```sh
gscdump query --site example.com --dimensions page,query \
  --start 2026-08-01 --end 2026-08-28 --limit 1000 --format json
```

- Dimension names are singular: `page`, `query`, `date`, `country`, `device`.
- A page breakdown uses `--tables pages` for sync and `-d page` for query.
  `-d page,query` needs `page_queries`; syncing only `pages` does not fill that table.
- Filters: `--query`, `--page`, `--country`, `--device`,
  `--search-appearance`. Prefixes: bare equals, `~` contains, `!~` not
  contains, `re:` regex, `!re:` not regex, `!` not equals.
- `--page` takes a path or a full URL. The Store compares paths.
- Without dates, `query` reads the 28 days ending on the newest synced day.
- `--live` bypasses the Store and needs Local mode. `--type` selects a search type. The default is `web`.
  `--data-state` and `--aggregation-type` apply to live mode only.
- Metrics already include clicks, impressions, CTR, and position. There is no `--metrics` option.
- If Store coverage is missing, read the JSON error and run its `nextCommand`. It syncs only the missing dates and tables.
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
- `sites.json` lists each exported Site URL with its Store ID.

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
- On a traffic collapse, run `gscdump analyze trajectory --site example.com --json` first. It reads the whole
  record, 486 days by default. Quote `classification._tag`, such as `launch-honeymoon-then-cliff` or `sudden-drop`,
  with its dates, and quote `basis`. `basis._tag` is `clicks` when impressions cannot carry the read, for example
  when the peak falls in the period Search Console over-counted impressions, which ended 2026-04-27.

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
- With local authentication, the command fails. Pipe `gscdump sitemaps urls <sitemap-url>` into `gscdump inspect --site <site>` instead.

## Read the coverage ladder (hosted)

```sh
gscdump indexing summary --site example.com --json
gscdump indexing summary --site example.com --days 90 --json
```

The command reads saved URL Inspection verdicts. It spends no inspection quota.
Each day in `trend` has `coverageStates`:

- `counted` has `counts`, one URL count per coverage state, and `capturedAt`, the time gscdump counted them.
- `not_counted` means gscdump stored the day before it counted coverage states. That day has no ladder. Say so.

Read the 4 ladder states in `counts`, lowest rung first. Name each state with these words:

| Key | Name | Meaning |
| --- | --- | --- |
| `unknown_to_google` | unknown | Google has no record of the URL |
| `discovered_not_indexed` | discovered | Google queued the URL and has not crawled it |
| `crawled_not_indexed` | crawled | Google crawled the URL and left it out of the index |
| `indexed` | indexed | Google indexed the URL |

The other keys in `counts` are exclusions, such as `noindex`, `not_found`, and `redirect`.
`unrecognized` counts coverage text gscdump cannot map yet. `not_reported` counts results with no coverage text.
A newer host can add keys to `counts`. Treat a key you do not know as its own state. Treat a missing key as 0.

Rules for every answer:

- `capture.source` is `stored` for counts gscdump saved on its daily run, and `live` for counts made during the request.
- Quote `capturedAt` with every count. Also quote `capture.oldestVerdictAt` and the `capture.freshness` percents: `olderThan7dPercent` and `olderThan30dPercent`.
- If `capture._tag` is `empty`, gscdump holds no verdicts for the Site. Report no ladder.
- The counts are stored URL Inspection verdicts. They are not Google's live index.
  They are also not the Search Console Page indexing report. The two can differ a lot, and the Page indexing report can list many more URLs.
- `olderThan7d` and `olderThan30d` count verdicts inspected more than 7 times 24 hours and 30 times 24 hours before `capturedAt`. They are not calendar days.
- A verdict can be months older than its capture. Unchanged URLs are rechecked less often over time. Say when most verdicts are old.
- A move between rungs shows in the trend. Compare two `counted` days and name the dates.
- `capture.scope` says which URLs the counts cover. `sitemap_members` means every counted URL is in a live sitemap.
  `inspected_urls` means sitemap membership was not available, so the counts can include URLs outside every sitemap.
- If `unknown_to_google` URLs are already in a sitemap, the sitemap is not the gap. Do not tell the owner to add them to it.
  Read the sitemap's last download with `gscdump sitemaps current --site SITE --json`. If Google downloaded it, say that Google read the sitemap and did not take the URLs.
  Check one URL's membership with `gscdump sitemaps membership`.
- Name no cause beyond what the evidence shows.
- Cite the command behind each number.

## Watch URLs (hosted)

```sh
gscdump indexing watch add --site example.com https://example.com/guide https://example.com/pricing
gscdump indexing watch list --site example.com --json
gscdump indexing watch remove --site example.com https://example.com/pricing
```

- A Site can hold 50 Watched URLs. `add` and `remove` send 50 URLs per request, so a longer list works. Every URL must be absolute. `add` fails before any request if one is relative.
- If `add` skips a URL with `inspection_disabled`, the Site has URL Inspection off. gscdump never inspects it, so the URL gets no Checkpoint. Tell the owner to turn on URL Inspection in the Site settings.
- gscdump inspects each Watched URL every 7 days, before other scheduled URLs. It never backs off.
- Each scheduled inspection spends the Site's daily URL Inspection budget and the URL Inspections meter. Get consent before `add`.
- Each scheduled inspection stores one Checkpoint. `watch list --json` returns Checkpoints newest first, with `checkedAt`, the `coverageState` key, and Google's text.
- Compare Checkpoints by date to see when a URL moves up the ladder. A new Watched URL has no Checkpoint until its first inspection.
- `remove` deletes the URL's Checkpoints. The saved URL Inspection results stay.

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
  delete local data. `indexing watch add` spends URL Inspections every week,
  and `indexing watch remove` deletes Checkpoints. `--yes` is consent you
  borrow from the user.
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
The user saying credentials work does not replace this check. It identifies the selected access mode.
In Local mode, check Store metadata next, keep the requested dimensions, and read or sync only the requested dates.
If the user requests JSON, return the command's JSON unchanged, without a table or a separate totals summary.
Include that JSON in your final response. Tool output alone is not a final answer.
Include every returned row. Do not refer the user to results "above".

For a deletion explanation, read metadata only if needed. Explain the scope and ask for consent, then stop.
