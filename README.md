<h1>gscdump</h1>

[![npm version](https://img.shields.io/npm/v/gscdump?color=yellow)](https://npmjs.com/package/gscdump)
[![npm downloads](https://img.shields.io/npm/dm/gscdump?color=yellow)](https://npm.chart.dev/gscdump)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> The AI Search Console primitive for agents. Typed, streaming, edge-ready.

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

- 🤖 **Agent-native** - 9 intent-keyed reports + 28 raw analyzers, deterministic JSON, bounded findings. Agents drive the CLI (`gscdump report ...`) or the slim MCP shell (`list-reports` + `run-report`).
- 🔍 **28 SEO analyzers** - striking distance, cannibalization, decay, movers, intent atlas, CTR anomaly, survival, change-point, and more. Each one is an agent tool.
- 📋 **Reports** - composed analyses: `health`, `movers`, `opportunities`, `risks`, `priority`, `growth`, `brand`, `triage <page|query>`, `pre-publish <topic>`. One question per report.
- 💾 **Own your data** - sync GSC into a local DuckDB/Parquet store. No BigQuery, no 16-month expiry, no row caps.
- ⚡ **Indexing + sitemaps** - URL inspection, batch indexing, sitemap CRUD.
- 🎯 **Typed query builder** - Drizzle-style API with streaming pagination.
- 🌐 **Edge-compatible** - runs in Cloudflare Workers, Deno, Bun, Node.

## What is gscdump?

gscdump is the search-data substrate for AI agents. Google Search Console is the first engine; the surface area is everything an agent needs to reason about how a site shows up in search, classical and AI.

The Google APIs were built for dashboards: the UI caps at 1,000 rows, the API at 25k per request, BigQuery export is the only escape, and data evaporates after 16 months. None of that fits an agent loop. gscdump gives you a typed client, a streaming store you control, 28 analyzers, and an MCP server that exposes them as discrete tools and resources.

## Get Started

```bash
# First-run setup
npx gscdump init

# List your sites
npx gscdump sites

# Export last 28 days
npx gscdump dump --site sc-domain:example.com

# Run custom query
npx gscdump query --site sc-domain:example.com --dimensions page,query

# Start MCP server
npx gscdump mcp
```

### Commands

| Command | Description |
|---------|-------------|
| `init` | Full setup (OAuth + data dir) |
| `auth` | Manage authentication (`status`, `login`, `logout`) |
| `dump` | Export search analytics to stdout/file |
| `query` | Run custom queries (reads local store by default; `--live` hits GSC) |
| `sync` | Pull GSC rows into the local DuckDB/Parquet store |
| `sites [--with-sitemaps]` | List GSC properties |
| `sitemaps` | List/manage sitemaps |
| `inspect <url>` / `inspect batch` | URL inspection (single or batch) |
| `indexing` | Indexing API: `submit`, `remove`, `status`, `batch` |
| `analyze` | Run SEO analyzers against local data (`--live` for row-based via API) |
| `report` | Run intent-keyed reports (composes analyzers into bounded sections) |
| `entities` | Entity extraction over local data |
| `store stats` | Show row/byte counts, disk footprint, sync watermarks |
| `store compact` | Roll daily partitions older than N days into monthly files |
| `store gc` | Delete orphaned object-store files |
| `store export` | Export raw Parquet files |
| `store rollups` | Rebuild post-sync rollup tables |
| `config` | Manage CLI configuration |
| `mcp` | Start MCP server for AI assistants |

### Analyzers

`gscdump analyze <tool>` runs one of:

| Tool | What it surfaces |
|------|------------------|
| `striking-distance` | Keywords ranking just outside page 1 |
| `opportunity` | High-impression, low-CTR pages worth optimizing |
| `movers` | Biggest clicks/impressions gainers and losers vs. a prior period |
| `decay` | Pages losing traffic over time |
| `survival` | Page lifetime / churn analysis |
| `change-point` | Statistical breakpoints in traffic |
| `brand` | Brand vs. non-brand share of clicks |
| `cannibalization` | Multiple pages competing for the same query |
| `clustering` | Groups of related queries by prefix or intent |
| `concentration` | How traffic concentrates across pages/keywords |
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
| `keyword-breadth` | How wide each page's keyword footprint is |
| `long-tail` | Long-tail vs. head distribution |
| `dark-traffic` | Impressions on hidden/anonymized queries |
| `device-gap` | Desktop vs. mobile performance gaps |
| `bipartite-pagerank` | Page↔query graph centrality |
| `content-velocity` | Publish cadence vs. traffic response |
| `data-detail` / `data-query` | Raw drill-downs for agents |

## Reports

`gscdump report <id>` runs a composed analysis and returns a structured `ReportResult` (sections of bounded findings + agent-actionable next steps). Lower volume than running raw analyzers; same data, narrated for the question you actually have.

| Report | Plan steps | Default window | Comparison |
|--------|------------|----------------|------------|
| `health` | ctr-anomaly, change-point, position-volatility | 28d | none |
| `movers` | movers, decay, striking-distance | 7d | prev-period |
| `opportunities` | striking-distance, opportunity, zero-click, query-migration | 28d | none |
| `risks` | decay, cannibalization, dark-traffic, device-gap | 28d | prev-period |
| `priority` | striking-distance + opportunity + cannibalization + ctr-anomaly + change-point, ranked | 28d | prev-period |
| `growth` | content-velocity, keyword-breadth, intent-atlas, long-tail | 90d | yoy |
| `brand` | brand (`--brand-terms`), concentration | 28d | none |
| `triage` | change-point + query-migration + position-volatility scoped to `--target` | 90d | none |
| `pre-publish` | cannibalization + striking-distance scoped to `--topic` | 90d | none |

```bash
# List reports
gscdump report list

# Plan-only preview (no auth, no API calls)
gscdump report movers --explain

# Run + machine-read
gscdump report opportunities --site sc-domain:example.com --json

# Parameterized
gscdump report triage --target /blog/foo --target-kind page --json
gscdump report pre-publish --topic "widgets" --json
gscdump report brand --brand-terms "acme,acme corp" --json
```

Window flags: `--period {7d|28d|30d|90d|180d|365d|mtd|ytd|custom}`, `--vs {none|prev-period|yoy}`, `--start`/`--end` (with `--period custom`), `--prev-start`/`--prev-end` (override comparison).

### Programmatic use

```ts
import {
  defaultAnalyzerRegistry,
  defaultReportRegistry,
  runReport,
} from '@gscdump/analysis'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { resolveWindow } from '@gscdump/engine/period'

const report = defaultReportRegistry.getReport('health')!
const window = resolveWindow({ preset: 'last-28d', comparison: 'none' })
const source = createGscApiQuerySource({ client, siteUrl })

const result = await runReport(report, {
  source,
  analyzers: defaultAnalyzerRegistry,
  ctx: { site: siteUrl, window, params: {}, registryVersion: defaultReportRegistry.version },
})
// result.sections[*].findings — bounded, sorted, page/query-keyed
// result.sections[*].actions  — structured next-step hints (kind/target/params)
// result.meta.degraded         — true if any optional step failed
```

Define your own with `defineReport()` from `@gscdump/engine/report` (mirrors `defineAnalyzer`):

```ts
import { defineReport } from '@gscdump/engine/report'

export const myReport = defineReport({
  id: 'my-report',
  description: '...',
  defaultPeriod: 'last-28d',
  defaultComparison: 'none',
  argsSpec: { 'max-findings': { type: 'number', default: 5 } },
  plan: (params, window) => [
    { key: 'striking', type: 'striking-distance', params: { startDate: window.start, endDate: window.end }, required: true },
  ],
  reduce: (results, ctx) => ({ sections: [/* ... */] }),
})
```

**Known v1 limitations:**
- `growth` aggregate sections (content-velocity, keyword-breadth, intent-atlas) surface info via `summary.magnitudeLabel` rather than per-row findings — those analyzers aren't page-or-query keyed. Drill in via `artifact.analyzer`.
- `brand` concentration step runs site-wide, not brand-filtered (no analyzer support yet); section title is explicit.

## MCP Server

Add to your Claude config (`~/.claude.json` or VS Code settings):

```json
{
  "mcpServers": {
    "gscdump": {
      "command": "npx",
      "args": ["gscdump", "mcp"]
    }
  }
}
```

Then ask Claude:

- "Run the health report on `sc-domain:example.com`."
- "What are this week's biggest movers?" (→ `run-report` with `id: 'movers'`)
- "Triage `/blog/foo` — what changed?" (→ `run-report` with `id: 'triage', target: '/blog/foo'`)
- "Before I publish on `widgets`, are we already targeting it?" (→ `run-report` with `id: 'pre-publish', topic: 'widgets'`)
- "Check if this URL is indexed and request indexing if not."
- "Audit my site for cannibalization risks." (→ `run-report` with `id: 'risks'`)

### MCP Tools

The MCP shell is intentionally slim: agents drive the report layer for analysis and the raw `query` tool when they need rows.

**Reports:** `list-reports`, `run-report` — surface the same intents as `gscdump report`. `list-reports` returns id, description, default period/comparison, and `argsSpec`; `run-report` accepts `{ siteUrl, id, period?, comparison?, start?, end?, prevStart?, prevEnd?, maxFindings? }` and returns the structured `ReportResult`.

**Sites:** `list-sites`, `list-sites-with-sitemaps`, `list-sitemaps`, `get-sitemap`, `submit-sitemap`, `delete-sitemap`

**Custom queries:** `query` — dimension filters (regex/contains/equals), multiple groups OR-ed together. Use this for raw rows; the previous `fetch-pages` / `fetch-keywords` / `fetch-countries` / `fetch-devices` tools were removed in favour of report-driven flows.

**Indexing:** `inspect-url`, `request-indexing`, `get-indexing-status`, `batch-request-indexing`, `batch-inspect-urls`

## API Usage

```ts
import { googleSearchConsole } from 'gscdump/api'
import { between, date, gsc, page, query } from 'gscdump/query'

// Create client with auth
const client = googleSearchConsole({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
})

// Build query
const builder = gsc
  .select(page, query)
  .where(between(date, '2024-01-01', '2024-01-31'))
  .limit(10000)

// Stream results (async generator)
for await (const batch of client.query('sc-domain:example.com', builder)) {
  console.log(batch) // Array of { page, query, clicks, impressions, ctr, position }
}
```

### Query Builder

```ts
import { and, between, contains, country, date, device, eq, gsc, page, query } from 'gscdump/query'

const builder = gsc
  .select(page, query, device, country)
  .where(and(
    eq(device, 'MOBILE'),
    contains(page, '/blog/')
  ))
  .where(between(date, '2024-01-01', '2024-01-31'))
  .limit(25000)

// Get raw API body
const body = builder.toBody()
```

**Dimensions:** `page`, `query`, `date`, `country`, `device`, `searchAppearance`

**Operators:** `eq`, `ne`, `contains`, `like`, `regex`, `notRegex`, `inArray`, `between`, `and`, `or`, `not`

### Other Client Methods

```ts
// List sites
const sites = await client.sites()

// Inspect URL
const { inspection, isIndexed } = await client.inspect(siteUrl, url)

// Sitemaps
const sitemaps = await client.sitemaps.list(siteUrl)
await client.sitemaps.submit(siteUrl, 'https://example.com/sitemap.xml')

// Indexing API
await client.indexing.publish(url, 'URL_UPDATED')
const metadata = await client.indexing.getMetadata(url)
```

## Auth Setup

Bring your own Google OAuth credentials:

1. Create a Google Cloud project
2. Enable "Search Console API" and "Web Search Indexing API"
3. Create OAuth2 credentials (Desktop app)
4. Run `npx gscdump init` (or `npx gscdump auth login` if you don't want to write config)

### BYOK environment variables

The CLI runs without `init` if any of these env vars are set (`GSC_*` preferred, `GOOGLE_*` accepted):

```bash
# Option A: raw bearer token (e.g., from gcloud)
GSC_ACCESS_TOKEN=ya29...

# Option B: refresh-token flow
GSC_CLIENT_ID=...
GSC_CLIENT_SECRET=...
GSC_REFRESH_TOKEN=...
```

When BYOK is detected, `gscdump auth status` reports `byok` as the source.

## Packages

| Package | Description |
|---------|-------------|
| [`gscdump`](./packages/gscdump) | Core library: REST client + typed query builder |
| [`@gscdump/analysis`](./packages/analysis) | SEO analyzers (row-based + SQL-native) |
| [`@gscdump/engine`](./packages/engine) | Storage, resolver, query-source, and Iceberg adapters |
| [`@gscdump/lakehouse`](./packages/lakehouse) | Dataset-agnostic Iceberg catalog and registry |
| [`@gscdump/contracts`](./packages/contracts) | Hosted API and v1 wire contracts |
| [`@gscdump/sdk`](./packages/sdk) | Hosted HTTP and ticketed realtime clients |
| [`@gscdump/cloudflare`](./packages/cloudflare) | Cloudflare Workers/R2 helpers |
| [`@gscdump/cli`](./packages/cli) | CLI and MCP server (`gscdump mcp`) |

## License

[MIT](./LICENSE)
