<h1>gscdump</h1>

[![npm version](https://img.shields.io/npm/v/gscdump?color=yellow)](https://npmjs.com/package/gscdump)
[![npm downloads](https://img.shields.io/npm/dm/gscdump?color=yellow)](https://npm.chart.dev/gscdump)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

Query Google Search Console, keep local history, and run SEO analysis from TypeScript, the CLI, or an AI assistant.

<p align="center">
<table>
<tbody>
<td align="center">
<sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br> Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub><br>
</td>
</tbody>
</table>
</p>

## Features

- **Local history:** sync Search Console rows to a Parquet Store and query them with DuckDB.
- **SEO analysis:** 29 Analyzers and eight Reports for traffic changes, content decay, query overlap, and optimization opportunities.
- **AI assistants:** an MCP server for Reports, custom queries, Site management, and URL inspection.
- **Typed clients:** Google Search Console and Bing Webmaster calls, plus a query builder with streaming pagination.
- **Indexing Evidence:** inspect URLs, read Bing crawl evidence, and manage Google sitemap submissions.

The core `gscdump` library uses `fetch` and supports edge runtimes.
The CLI and local Store run on Node.js 22 or newer.
Pagination follows Google's available rows; it cannot recover data Google omits.
See [Google's data limits](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data).

## Get started

```bash
npm install -g @gscdump/cli

# Set up your Google OAuth credentials and Store directory
gscdump init
gscdump sites

# Sync before querying or exporting stored data
gscdump sync --site sc-domain:example.com --days 90 --tables pages,queries,page_queries,countries
gscdump query --site sc-domain:example.com --dimensions page,query
gscdump dump --site sc-domain:example.com --out ./export

# Query Google directly
gscdump query --live --site sc-domain:example.com --dimensions page,query
```

The explicit sync table list avoids the current [daily totals limitation](./docs/guides/historical-database.md#stored-tables).

For one-off commands, use `npx -y @gscdump/cli` in place of `gscdump`.
The `gscdump` npm package contains the library; `@gscdump/cli` provides the command.

Guides:

- [Getting started](./docs/guides/getting-started.md)
- [Keep historical data](./docs/guides/historical-database.md)
- [SEO analysis](./docs/guides/seo-analysis.md)
- [AI integration](./docs/guides/ai-integration.md)
- [URL inspection and indexing](./docs/guides/url-indexing.md)

### Commands

| Command | Purpose |
| --- | --- |
| `init`, `auth`, `profile` | Set up credentials and manage profiles |
| `sites`, `sitemaps` | Manage Sites, verification, and sitemaps |
| `sync` | Fetch Google data into the Store |
| `query` | Query stored rows, or Google with `--live` |
| `dump` | Export stored files to a directory |
| `analyze <tool>` | Run one Analyzer |
| `report <id>` | Run a Report |
| `inspect`, `indexing`, `entities` | Inspect URLs, send eligible notifications, and save evidence |
| `store` | Read stats, compact files, collect orphaned files, export DuckDB, or rebuild Rollups |
| `config`, `doctor` | Configure the CLI and diagnose setup problems |
| `mcp` | Start the MCP server |

See the [CLI reference](./packages/cli/README.md) for flags and authentication options.

### Analyzers

Run `gscdump analyze <tool> --help` for each Analyzer's options.
Twelve Analyzers support live rows; all 29 support SQL over stored data.
See [Source support](./packages/analysis/README.md#sources) before choosing `--live`.

| Analyzer | What it finds |
|------|------------------|
| `striking-distance` | Queries in positions 4 to 20 with low CTR |
| `opportunity` | High-impression, low-CTR pages worth optimizing |
| `movers` | Biggest clicks/impressions gainers and losers vs. a prior period |
| `decay` | Pages losing traffic over time |
| `survival` | Page lifetime / churn analysis |
| `change-point` | Statistical breakpoints in traffic |
| `brand` | Brand vs. non-brand share of clicks |
| `cannibalization` | Multiple pages competing for the same query |
| `clustering` | Groups of related queries by prefix or intent |
| `concentration` | How traffic concentrates across pages/queries |
| `seasonality` | Monthly/weekly cyclicality in traffic |
| `stl-decompose` | Trend/seasonal/residual decomposition |
| `zero-click` | High-impression queries with no clicks |
| `trends` | Rolling-window clicks/impressions trajectory |
| `ctr-curve` | Empirical CTR-by-position curve for the site |
| `ctr-anomaly` | Pages over/under-performing the CTR curve |
| `bayesian-ctr` | Shrinkage-adjusted CTR estimates |
| `position-distribution` | Position histogram per page/query |
| `position-volatility` | Rank stability scoring |
| `intent-atlas` | Query-intent map across the site |
| `query-migration` | Queries shifting between pages over time |
| `keyword-breadth` | How wide each page's query coverage is |
| `long-tail` | Long-tail vs. head distribution |
| `dark-traffic` | Impressions on hidden/anonymized queries |
| `device-gap` | Desktop vs. mobile performance gaps |
| `bipartite-pagerank` | Page↔query graph centrality |
| `content-velocity` | Publish cadence vs. traffic response |
| `data-detail` / `data-query` | Raw drill-downs for agents |

## Reports

`gscdump report <id>` combines Analyzers into a `ReportResult` with bounded Sections and next steps.

| Report | Analyzers | Default window | Comparison |
|--------|------------|----------------|------------|
| `health` | ctr-anomaly, change-point, position-volatility | 28d | none |
| `movers` | movers, decay, striking-distance | 7d | prev-period |
| `opportunities` | striking-distance, opportunity, zero-click, query-migration | 28d | none |
| `risks` | decay, cannibalization, dark-traffic, device-gap | 28d | prev-period |
| `growth` | content-velocity, keyword-breadth, intent-atlas, long-tail | 90d | yoy |
| `brand` | brand (`--brand-terms`), concentration | 28d | none |
| `triage` | change-point + query-migration + position-volatility scoped to `--target` | 90d | none |
| `pre-publish` | cannibalization + striking-distance scoped to `--topic` | 90d | none |

```bash
gscdump report list
gscdump report movers --explain
gscdump report opportunities --site sc-domain:example.com --json
gscdump report triage --site sc-domain:example.com --target /blog/foo --target-kind page --json
gscdump report pre-publish --site sc-domain:example.com --topic widgets --json
gscdump report brand --site sc-domain:example.com --brand-terms 'acme,acme corp' --json
```

Use `--period` for `7d`, `28d`, `30d`, `90d`, `180d`, `365d`, `mtd`, `ytd`, or `custom`.
Use `--vs` for `none`, `prev-period`, or `yoy`.
Custom windows need `--start` and `--end`; comparison overrides use `--prev-start` and `--prev-end`.

Analyzer, Report, and Section IDs are separate namespaces.
For example, `brand` names both an Analyzer and a Report.
Check `result.meta.degraded` for failed optional steps.
Some `growth` Sections return aggregate summaries instead of per-row findings.
The `brand` Report's concentration step covers the whole Site.

## MCP server

Add this entry to your MCP client's server configuration:

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

Authenticate first with `gscdump init` or environment variables.
Then ask your assistant to run a live Report, such as `movers`, or query a Site.
MCP Report inputs and Source support have [limits](./docs/guides/ai-integration.md).
See [AI integration](./docs/guides/ai-integration.md) for available tools and credentials.

## TypeScript

```bash
npm install gscdump
```

```ts
import { googleSearchConsole } from 'gscdump'
import { between, date, gsc, page, query } from 'gscdump/query'

const client = googleSearchConsole({ accessToken: process.env.GSC_ACCESS_TOKEN! })
const request = gsc
  .select(page, query)
  .where(between(date, '2026-08-01', '2026-08-31'))
  .limit(10000)

for await (const rows of client.query('sc-domain:example.com', request)) {
  console.log(rows)
}
```

See the [core library](./packages/gscdump/README.md) for authentication, query methods, and Bing Indexing Evidence.
See [analysis](./packages/analysis/README.md) for programmatic Analyzers and Reports.

## Hosted API v1

Use `@gscdump/sdk/v1` for the hosted gscdump.com API.
The current contracts describe 55 HTTP operations: 50 partner, three analytics, and two realtime operations.
The API wire version is `1.0`, separate from npm package versions.

Start with the [hosted integration guide](./docs/guides/hosted-v1.md).
The [generated contracts](./packages/contracts/generated) define operation inputs and responses.
Existing integrations can use the [migration guide](./docs/v1-migration.md).

## Packages

| Package | Purpose |
| --- | --- |
| [`gscdump`](./packages/gscdump) | Google and Bing clients, typed query builder |
| [`@gscdump/cli`](./packages/cli) | CLI and MCP server |
| [`@gscdump/analysis`](./packages/analysis) | Analyzers and Reports |
| [`@gscdump/engine`](./packages/engine) | Parquet storage, DuckDB execution, and Source contracts |
| [`@gscdump/engine-duckdb-wasm`](./packages/engine-duckdb-wasm) | Browser DuckDB runtime |
| [`@gscdump/engine-sqlite`](./packages/engine-sqlite) | SQLite and D1 adapter |
| [`@gscdump/engine-gsc-api`](./packages/engine-gsc-api) | Live Google API Source |
| [`@gscdump/lakehouse`](./packages/lakehouse) | Iceberg catalog and dataset registry |
| [`@gscdump/contracts`](./packages/contracts) | Hosted API schemas and operation metadata |
| [`@gscdump/sdk`](./packages/sdk) | Hosted HTTP, realtime, and webhook clients |
| [`@gscdump/cloudflare`](./packages/cloudflare) | Cloudflare server-tail and request deduplication helpers |

## License

[MIT](./LICENSE)
