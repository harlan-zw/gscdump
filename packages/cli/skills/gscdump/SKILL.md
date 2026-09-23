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
Example: `gscdump query --site=SITE --start=DATE --end=DATE -d page -f json`.

## Start each task

1. Before reading traffic, run `gscdump auth status --json`. Do this even when the user says authentication works.
2. Keep the requested Site, dates, dimensions, and task scope. A request for pages does not need query dimensions.
3. Before local queries, check coverage with `gscdump store stats --site SITE --json`.
   Use `gscdump sync --site SITE --status --json` when you need sync-state details.
4. Read the table dimensions and watermarks. Sync only missing tables and the requested dates, once per task.
5. Use `sync --json`. Read its completion result before deciding what to do next. Never repeat a successful sync.

If the task only asks about deletion, explain the scope and ask for consent.
You may read Store metadata with `store stats` and `sync --status`.
Do not query traffic, sync rows, or delete data to explain deletion.
Call the local data directory the Store in your answer.

## Authentication mode

Check `gscdump auth status --json` before queries. Reuse the user's selected mode.

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
Hosted sitemap membership and history require hosted credentials.

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

For Google, use the exact value that `gscdump sites` prints.

- Domain property: `sc-domain:example.com`
- URL-prefix property: `https://example.com/` (trailing slash included)

For cloud Bing commands, use a Site ID from `gscdump bing sites`, such as `s_SITE_ID`.
For local Bing commands, use the full verified Site URL from `gscdump bing sites --mode local`.
Bing commands require their own explicit `--site`; the Google `defaultSite` setting does not select a Bing Site.

Set a default once to drop `--site` from later commands:

```sh
gscdump config set defaultSite sc-domain:example.com
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
| `gscdump inspect <url>` | URL Inspection with Indexing Evidence |
| `gscdump sitemaps` | List, submit, delete, and probe sitemaps |
| `gscdump indexing` | Indexing API notifications and quota |
| `gscdump dump` | Export Store tables, inspections, sitemaps, and Bing data with file sizes |
| `gscdump store` | Store stats, compaction, garbage collection, resets |
| `gscdump entities` | Snapshot URL inspections into the entity store |
| `gscdump config` | Defaults such as `defaultSite`, `dataDir`, `defaultLimit` |
| `gscdump profile` | Separate credential and config directories |
| `gscdump auth` | `status`, `login`, `logout`, `refresh` |
| `gscdump doctor` | Health checks for auth, scopes, Store, and reachability |
| `gscdump init` | Interactive first-time setup |
| `gscdump mcp` | Start Google MCP tools with the selected authentication |
| `gscdump skill install` | Copy this skill into an agent skill directory |
| `gscdump papercut` | Report a CLI problem to gscdump.com |

`gscdump login`, `gscdump logout`, and `gscdump status` are top-level aliases of
the matching `auth` subcommands.
The MCP server does not expose Bing tools. Use `gscdump bing` commands through this skill.

## Sync before local analysis

```sh
gscdump store stats --site sc-domain:example.com --json
gscdump sync --site sc-domain:example.com --days 90 \
  --tables pages,queries,page_queries,countries --json
gscdump sync --site sc-domain:example.com --status --json
```

- Sync covers every table and search type by default. Pass `--tables` and
  `--types` to sync less. Sync skips table and type pairs Google cannot answer.
- `--full` backfills the 486 days Google keeps.
- Sync also saves the sitemap list, sitemap URLs, and URL Inspection results.
  It inspects up to 50 due URLs per run. `--inspect-limit N` changes that.
  `--no-sitemaps` and `--no-inspections` skip those steps. Read the
  `sitemaps` and `inspections` fields of `sync --json`.
- Sync skips completed dates. `--force` refreshes them. `--retry-failed`
  reruns only failed dates.
- `--dry-run` prints the planned work without calling Google.
- Use the user's date range. The 90-day example does not authorize a wider sync.
- Empty Store metadata is expected before the first sync. It does not prove zero traffic.

## Query rows

```sh
gscdump query --site sc-domain:example.com --dimensions page,query \
  --start 2026-08-01 --end 2026-08-28 --limit 1000 --format json
```

- Dimension names are singular: `page`, `query`, `date`, `country`, `device`.
- Filters: `--query`, `--page`, `--country`, `--device`,
  `--search-appearance`. Prefixes: bare equals, `~` contains, `!~` not
  contains, `re:` regex, `!re:` not regex, `!` not equals.
- `--live` bypasses the Store. `--type` selects a search type.
  `--data-state` and `--aggregation-type` apply to live mode only.
- Metrics already include clicks, impressions, CTR, and position. There is no `--metrics` option.
- If Store coverage is missing, read the JSON error and its bounded `nextArgs` before syncing.
  Do not switch dimensions to make a failed query succeed.
- `--explain` prints the request body or planned SQL without executing.
- `--sql` runs raw DuckDB SQL over the Store with `{{FILES}}` as the file list.

## Analyze and report

```sh
gscdump report list --json
gscdump report opportunities --site sc-domain:example.com --json
gscdump report movers --site sc-domain:example.com --period 28d --vs prev-period --json
gscdump analyze list --json
gscdump analyze striking-distance --site sc-domain:example.com --json
```

- Report ids: `brand`, `growth`, `health`, `movers`, `opportunities`,
  `pre-publish`, `risks`, `triage`.
- `--period` takes `7d`, `28d`, `90d`, `mtd`, `ytd`, or `custom` with
  `--start` and `--end`. `--vs` takes `none`, `prev-period`, or `yoy`.
- `report <id> --explain` prints the plan without credentials or data.
- `triage` needs `--target <page-or-query> --target-kind page|query`.
  `pre-publish` needs `--topic`. `brand` needs `--brand-terms 'a,b'`.
- Analyzers take `--start` and `--end`. `movers` and `decay` also take
  `--prev-start` and `--prev-end`. `--period` and `--vs` belong to `report`.
- SQL-only Analyzers need Store rows. `--live` runs row-based Analyzers
  against Google.
- Results name candidates for review. They do not prove why traffic changed.

## Inspect and index

```sh
gscdump inspect https://example.com/page --site sc-domain:example.com --json
gscdump inspect batch --site sc-domain:example.com --file urls.txt --json
gscdump indexing quota --json
```

Inspection spends Google's separate 2,000 requests per Site per day quota.
`indexing quota` describes Indexing API limits. It does not report remaining URL Inspection requests.
Report the Indexing Evidence fields as Google returned them.

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
