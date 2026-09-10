---
name: gscdump
description: Drive the `gscdump` CLI for Google Search Console work. Sync Search Console rows to a local Store, query pages and queries, run SEO Analyzers and Reports, inspect URL indexing, manage sitemaps, and report CLI papercuts. Use whenever the user mentions gscdump, the `gscdump` command, Search Console data, or GSC automation.
---

# gscdump CLI

`gscdump` reads Google Search Console through Google's API with the user's own
credentials. It keeps a local Parquet Store so repeated questions do not hit
Google again. Every command has `--help`.

Use it to answer "what is happening in search for this Site", then act on the
findings in the repository you are working in.

## Choose local or the platform first

There are two ways to reach Search Console data. They differ in who holds
the credentials and where the data lives. If the user has not said which one
they want, ask before you run anything. Do not guess.

| | Local CLI (this skill) | The platform (gscdump.com) |
| --- | --- | --- |
| Credentials | The user's own Google OAuth client, token, or service account | gscdump.com holds a read-only Google grant after sign-in |
| Where data lives | Parquet files on this machine | Synced continuously on gscdump.com, history kept past Google's 16 months |
| Setup cost | A Google Cloud project with the Search Console API enabled | Sign in once; free during beta |
| How you reach it | `gscdump` commands in this terminal | MCP over HTTP at `https://gscdump.com/mcp` |
| Good for | One machine, private data, CI, raw SQL over Parquet | Several clients, long history, no local sync to babysit |

Ask in one line, for example: "Do you want to use your own Google keys
locally with the gscdump CLI, or connect to your gscdump.com account?"

If the user chooses the platform, this skill does not apply. Connect the MCP
server instead and stop here:

```sh
claude mcp add --transport http --scope user gscdump https://gscdump.com/mcp
```

Claude, ChatGPT, and Claude Code sign in with OAuth. Cursor and Codex send an
API key from gscdump.com settings as the `x-api-key` header. Setup for each
client: https://gscdump.com/mcp

If the user chooses local, continue below.

## Data boundaries

- `sync`, `query --live`, `analyze --live`, `report --live`, `sites`,
  `sitemaps`, `inspect`, and `indexing` call Google.
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

Node 22 or newer is required. `gscdump` alone is the library; `@gscdump/cli`
provides the command.

## Install this skill

```sh
gscdump skill install --agent claude    # Codex: --agent codex
```

The command prints where it wrote the skill. Clients without a skill
directory can read `gscdump --help` and `gscdump <command> --help` instead.

## Authenticate

Check first. Never run `init` when credentials already work.

```sh
gscdump auth status
gscdump doctor --json
```

If `auth status` reports no credentials, use one of these paths:

| Path | When | Command |
| --- | --- | --- |
| Environment token | The user already has an OAuth access token | `export GSC_ACCESS_TOKEN=ya29...` |
| Refresh token | CI or a headless machine with OAuth client credentials | `export GSC_CLIENT_ID=... GSC_CLIENT_SECRET=... GSC_REFRESH_TOKEN=...` |
| Service account | CI with a service-account key that has Site access | `export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/key.json` |
| Interactive OAuth | A person is present | `gscdump init` |

`init` needs a Google Cloud OAuth client of type Desktop app. Ask the user to
run it; do not guess client credentials. Use `gscdump auth login --no-browser`
when a browser cannot open.

`--profile <name>` or `GSCDUMP_PROFILE` isolates credentials per Google
account.

## Site identifiers

Use the exact value that `gscdump sites` prints.

- Domain property: `sc-domain:example.com`
- URL-prefix property: `https://example.com/` (trailing slash included)

Set a default once to drop `--site` from later commands:

```sh
gscdump config set defaultSite sc-domain:example.com
```

## Output

Pass `--json` on every command that supports it. `query` uses
`--format json` and prints rows to stdout. Progress goes to stderr, so stdout
stays parseable. `--quiet` drops progress lines.

Parse JSON. Never scrape human output.

## Commands

| Command | Use it for |
| --- | --- |
| `gscdump sites` | List Sites and permission levels |
| `gscdump sync` | Copy Search Console rows into the local Store |
| `gscdump query` | Rows by page, query, date, country, or device |
| `gscdump analyze <id>` | One Analyzer over the Store or live rows |
| `gscdump report <id>` | A Report that composes several Analyzers |
| `gscdump inspect <url>` | URL Inspection with Indexing Evidence |
| `gscdump sitemaps` | List, submit, delete, and probe sitemaps |
| `gscdump indexing` | Indexing API notifications and quota |
| `gscdump dump` | Export Store tables to Parquet, CSV, JSON, or NDJSON |
| `gscdump store` | Store stats, compaction, garbage collection, resets |
| `gscdump entities` | Snapshot URL inspections into the entity store |
| `gscdump config` | Defaults such as `defaultSite`, `dataDir`, `defaultLimit` |
| `gscdump profile` | Separate credential and config directories |
| `gscdump auth` | `status`, `login`, `logout`, `refresh` |
| `gscdump doctor` | Health checks for auth, scopes, Store, and reachability |
| `gscdump init` | Interactive first-time setup |
| `gscdump mcp` | Start the MCP server for AI clients |
| `gscdump skill install` | Copy this skill into an agent skill directory |
| `gscdump papercut` | Report a CLI problem to gscdump.com |

`gscdump login`, `gscdump logout`, and `gscdump status` are top-level aliases of
the matching `auth` subcommands.

## Sync before local analysis

```sh
gscdump sync --site sc-domain:example.com --days 90 \
  --tables pages,queries,page_queries,countries
gscdump sync --site sc-domain:example.com --status
```

- Pass an explicit `--tables` list. The default list has a known daily-totals
  limitation.
- `--full` backfills the 450 days Google keeps.
- Sync skips completed dates. `--force` refreshes them. `--retry-failed`
  reruns only failed dates.
- `--dry-run` prints the planned work without calling Google.

## Query rows

```sh
gscdump query --site sc-domain:example.com --dimensions page,query \
  --start 2026-08-01 --end 2026-08-28 --limit 1000 --format json
```

- Dimension names are singular: `page`, `query`, `date`, `country`, `device`.
- Filters: `--query`, `--page`, `--country`, `--device`,
  `--search-appearance`. Prefixes: bare equals, `~` contains, `!~` not
  contains, `re:` regex, `!re:` not regex, `!` not equals.
- `--live` bypasses the Store. `--search-type`, `--data-state`, and
  `--aggregation-type` apply to live mode only.
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

Inspection spends the 2,000 per Site per day pool. Check `indexing quota`
before a batch. Report the Indexing Evidence fields as Google returned them.

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
- **Report the result as the CLI gave it.** An empty result is not a clean
  Site. Check `sync --status` for the covered date range before reading zero
  rows as zero traffic.
- **Do not widen the Site.** A `sc-domain:` property includes every
  subdomain. Filter with `--page` when the user means one host.
