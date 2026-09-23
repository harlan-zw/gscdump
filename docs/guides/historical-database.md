# Keep historical data in a Store

Sync Search Console data to local Parquet files, then query it with DuckDB.
Keep the files as long as you need them.

## First sync

After [authentication](./getting-started.md), choose a Store directory and sync 90 days:

```bash
gscdump config set dataDir /absolute/path/to/gsc-data
gscdump sync --site example.com --days 90 --tables pages,queries,page_queries,countries,dates
```

Without `--days`, sync fetches three days ending three days ago.
It skips dates already marked `done`.
Use `--force` when you need to refresh completed dates.

## Stored tables

Without `--types`, sync selects `web`.
The table choices used here are:

| Table | Data |
| --- | --- |
| `pages` | Daily page metrics |
| `queries` | Daily query metrics |
| `countries` | Country metrics |
| `page_queries` | Daily page/query pairs |
| `dates` | Site totals, device metrics, and anonymized impressions |
| `search_appearance` | Daily totals per search appearance |
| `search_appearance_pages`, `search_appearance_queries`, `search_appearance_page_queries` | Page and query rows for each search appearance |
| `hourly_pages` | Hourly page metrics for the last 10 days |

Default sync includes every table and every search type.
Sync skips pairs that Google cannot answer. Discover and Google News have no query or country rows.
Hourly rows cover only the last 10 days.
Stored empty-type markers skip search types with no data.
The `dates` sync combines separate requests for Site totals, device metrics, and query impressions.

Sync also rebuilds Rollups unless you pass `--no-rollups`.
Sync saves the sitemap list and sitemap URLs unless you pass `--no-sitemaps`.
Sync inspects up to 50 due URLs per run unless you pass `--no-inspections`.
Sync keeps 8 Search Analytics requests in flight and starts at most 600 per minute. `--requests-per-minute N` changes the rate.
Use `--inspect-limit N` to change the budget. Google allows 2,000 inspections per property per day.
Run `gscdump sync --help` for the full table and search-type options.

## Backfill and retry

```bash
# Start 486 days ago, ending three days ago
gscdump sync --site example.com --full

# Select an exact range
gscdump sync --site example.com --start 2026-08-01 --end 2026-08-31 \
  --tables pages,queries,page_queries,countries,dates

# Read sync progress
gscdump sync --site example.com --status

# Retry failed dates in the selected window
gscdump sync --site example.com --days 90 \
  --tables pages,queries,page_queries,countries,dates --retry-failed

# Refresh completed dates too
gscdump sync --site example.com --days 7 --force \
  --tables pages,queries,page_queries,countries,dates
```

Sync follows Google's pagination until a request returns no rows.
Google can omit rows, so a successful sync does not guarantee complete Search Console data.
See [Google's extraction guidance](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data).

## Select tables and search types

```bash
gscdump sync --site example.com --days 28 \
  --tables pages,queries,page_queries,countries,dates --types web,image
```

Each search type has separate files and sync state.
If a search type previously returned no data, use `--force-types` to check it again.
`--concurrency` controls simultaneous day requests per table; `--serial-tables` runs one table at a time.

## Automate a daily sync

Use a persistent machine with the CLI installed and a refresh token or service-account key configured.
Access tokens expire, so they need renewal for unattended use.

Save this as `sync-gsc.sh`, then make it executable:

```bash
#!/usr/bin/env bash
set -euo pipefail
/path/to/gscdump sync --site example.com --days 7 --force \
  --tables pages,queries,page_queries,countries,dates
```

Replace `/path/to/gscdump` with the output of `command -v gscdump`.
Run it daily with cron:

```cron
0 6 * * * /path/to/sync-gsc.sh >> /path/to/gsc-sync.log 2>&1
```

The scheduled process needs the same credentials and Store directory as your interactive shell.
If you use a temporary CI runner, restore and save the entire Store between runs.

## Query and export

```bash
gscdump query --site example.com --dimensions page --limit 100

gscdump dump --site example.com --format parquet --out ./parquet-export

gscdump store export --help
```

`dump` writes files to a directory.
`store export` creates a single `.duckdb` file.

## Maintain the Store

```bash
gscdump store stats
gscdump store compact --dry-run
gscdump store gc --dry-run
```

Compaction combines older daily data into weekly, monthly, and quarterly tiers.
Garbage collection removes orphaned files after the grace period.
It does not prune live historical data.
Review each preview before rerunning without `--dry-run`.

Store size depends on row counts and dimensions.
Use `store stats` to measure your data, and back up the whole Store directory.

## Next steps

- [Run SEO Analyzers and Reports](./seo-analysis.md)
- [Connect an AI assistant](./ai-integration.md)
- [Use the storage package](../../packages/engine/README.md)
