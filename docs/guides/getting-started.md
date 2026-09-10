# Getting started

Install the CLI, connect Google Search Console, then query live data or sync it to a local Store.

## Prerequisites

- Node.js 22 or newer.
- Access to a Site in Google Search Console.
- Your own Google OAuth credentials, access token, or service-account key.

## Install and authenticate

```bash
npm install -g @gscdump/cli
gscdump init
```

The `gscdump` npm package contains the library. Install `@gscdump/cli` to get the `gscdump` command.
You can also run any command with `npx -y @gscdump/cli`.

For OAuth setup:

1. Create a [Google Cloud project](https://console.cloud.google.com/).
2. Enable the Search Console API.
3. Create OAuth credentials with the Desktop app type.
4. Run `gscdump init`, choose a Store directory, and enter your credentials.
5. Complete Google sign-in.

If you already have an access token, set `GSC_ACCESS_TOKEN` and skip `init`.
For refresh tokens and service accounts, see [CLI authentication](../../packages/cli/README.md#auth).

```bash
export GSC_ACCESS_TOKEN=ya29.example
gscdump auth status
gscdump sites
```

Use the exact Site value returned by `sites`, such as `sc-domain:example.com` or `https://example.com/`.

## Query live data

```bash
gscdump query --live --site sc-domain:example.com --dimensions page,query --limit 1000
```

By default, `query` starts 31 days ago and ends three days ago.
Use `--start` and `--end` for a specific range.
Dimension names are singular: `page`, `query`, `date`, `country`, and `device`.

```bash
gscdump query --live --site sc-domain:example.com \
  --dimensions page,query --start 2026-08-01 --end 2026-08-31 --format csv --output ./search-analytics.csv
```

## Sync and query the Store

```bash
gscdump sync --site sc-domain:example.com --days 90 --tables pages,queries,page_queries,countries,dates
gscdump query --site sc-domain:example.com --dimensions page --limit 1000
```

Sync writes Parquet files to `~/.gscdump/data` unless you chose another directory.
Later queries read those files by default.
Daily totals combine Site totals, device metrics, and query impressions.
Google still controls which rows its API returns; pagination cannot recover omitted data.
See [Google's data limits](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data).

## Export stored data

```bash
# Copy Parquet files to a directory
gscdump dump --site sc-domain:example.com --out ./export

# Export the pages table as CSV files
gscdump dump --site sc-domain:example.com --tables pages --format csv --out ./export-csv
```

`dump` exports data already in the Store.
Use `query --output` to write a filtered result to one file.

## Set defaults

```bash
gscdump config set defaultSite sc-domain:example.com
gscdump config set dataDir /absolute/path/to/gsc-data
gscdump config show
```

After setting `defaultSite`, you can omit `--site`.
Changing `dataDir` selects a directory; it does not move existing files.

## Next steps

- [Keep historical data](./historical-database.md)
- [Run SEO Analyzers and Reports](./seo-analysis.md)
- [Connect an AI assistant](./ai-integration.md)
- [Inspect URLs and manage sitemaps](./url-indexing.md)
