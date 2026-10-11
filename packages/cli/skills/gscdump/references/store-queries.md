# Store queries

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

