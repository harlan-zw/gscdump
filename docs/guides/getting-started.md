# Getting started

Install the CLI, choose cloud or local authentication, then read Google Search Console or Bing data.

## Prerequisites

- Node.js 22.13 or later in the 22 release line, or Node.js 24 or later.
- Access to a Site in Google Search Console or Bing Webmaster Tools.
- A gscdump user API key for cloud mode, or local Search Engine credentials.

## Install and authenticate

```bash
npm install -g @gscdump/cli
```

The `gscdump` npm package contains the library. Install `@gscdump/cli` to get the `gscdump` command.
You can also run any command with `npx -y @gscdump/cli`.

Cloud mode uses the Search Engine connections saved on gscdump.com:

```bash
export GSCDUMP_API_KEY=gsd_user_...
gscdump auth login --mode cloud
gscdump auth status --json
gscdump sites --json
gscdump bing sites --json
```

Get a user API key from your gscdump.com settings.
The saved mode applies to Google and Bing within the selected profile.
Use `--mode cloud` or `--mode local` to override one command.

For local Google OAuth setup:

1. Create a [Google Cloud project](https://console.cloud.google.com/).
2. Enable the Search Console API.
3. Create OAuth credentials with the Desktop app type.
4. Run `gscdump init --mode local`, choose a Store directory, and enter your credentials.
5. Complete Google sign-in.
6. Run `gscdump auth login --mode local` to save local mode.

If you already have an access token, set `GSC_ACCESS_TOKEN` and skip `init`.
For refresh tokens and service accounts, see [CLI authentication](../../packages/cli/README.md#auth).

```bash
export GSC_ACCESS_TOKEN=ya29.example
gscdump auth login --mode local
gscdump auth status --json
gscdump sites --json
```

Pass a Site as you write it, such as `--site example.com`. The CLI resolves it to the Site that `sites` prints, so you do not type `sc-domain:`.

## Read Bing data

With cloud authentication, connect Bing for a Site listed by `bing sites`:

```bash
gscdump bing login --site s_SITE_ID
gscdump bing status --site s_SITE_ID --json
gscdump bing dump --site s_SITE_ID --format csv --out ./bing-export
```

Complete the browser connection before exporting. Hosted exports read the datasets saved by gscdump.com.
For local access, use a Bing Webmaster API key:

```bash
export BING_API_KEY=...
gscdump bing login --mode local
gscdump bing sites --json
gscdump bing dump --site https://example.com/ --format csv --out ./bing-export
```

Local exports read the rows Bing currently returns.
See [Bing authentication and exports](../../packages/cli/README.md#bing) for OAuth, datasets, date limits, and formats.

## Query live data

Google queries use the selected authentication mode.

```bash
gscdump query --live --site example.com --dimensions page,query --limit 1000
```

By default, `query` starts 31 days ago and ends three days ago.
Use `--start` and `--end` for a specific range.
Dimension names are singular: `page`, `query`, `date`, `country`, and `device`.

```bash
gscdump query --live --site example.com \
  --dimensions page,query --start 2026-08-01 --end 2026-08-31 --format csv --output ./search-analytics.csv
```

## Sync and query the Store

```bash
gscdump sync --site example.com --days 90 --tables pages,queries,page_queries,countries,dates
gscdump query --site example.com --dimensions page --limit 1000
```

Sync writes Parquet files to `~/.gscdump/data` unless you chose another directory.
Later queries read those files by default.
Daily totals combine Site totals, device metrics, and query impressions.
Google still controls which rows its API returns; pagination cannot recover omitted data.
See [Google's data limits](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data).

## Export stored data

```bash
# Copy Parquet files to a directory
gscdump dump --site example.com --out ./export

# Export the pages table as CSV files
gscdump dump --site example.com --tables pages --format csv --out ./export-csv
```

`dump` exports Google data already in the Store. `bing dump` reads Bing datasets through the selected authentication mode.
Use `query --output` to write a filtered result to one file.

## Set defaults

```bash
gscdump config set defaultSite example.com
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
