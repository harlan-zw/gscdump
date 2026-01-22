<h1>gscdump</h1>

[![npm version](https://img.shields.io/npm/v/gscdump?color=yellow)](https://npmjs.com/package/gscdump)
[![npm downloads](https://img.shields.io/npm/dm/gscdump?color=yellow)](https://npm.chart.dev/gscdump)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Export your Google Search data anywhere. Let AI query it directly.

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

- 💾 Own your data - export to any SQL database. No BigQuery, no 16-month expiry.
- 📊 Unlimited queries and row limits - GSC UI caps at 1k, API at 25k.
- 🤖 MCP Server - let Claude, Cursor, or any AI agent query your search data directly.
- 🔍 SEO analysis built-in - cannibalization, striking distance, movers & shakers, decay detection.
- ⚡ Indexing API - check index status, request indexing, batch operations.
- 🎯 Typed query builder - Drizzle-style API with filter constraints narrowing result types.
- 🌐 Edge-compatible - works in Cloudflare Workers, Deno, etc.

## What is gscdump?

Google's export options are broken for developers. The UI caps at 1,000 rows, the API stops at 25k per request, and bulk export locks you into BigQuery. Worse, GSC deletes your data after 16 months.

With gscdump you get an MCP server that lets AI agents query your search data directly, a CLI for scripting and automation, built-in SEO analysis like keyword cannibalization and striking distance, plus indexing tools to check status and request indexing.

Export complete data with no row limits to any database you control. Your data, your infrastructure, forever.

## Get Started

```bash
# First-run setup (choose cloud or local auth)
npx @gscdump/cli init

# List your sites
npx @gscdump/cli sites

# Dump last 7 days to stdout
npx @gscdump/cli dump --site https://example.com --period 7d

# Sync to SQLite database
npx @gscdump/cli sync --site https://example.com --db ./gsc.db

# Compare periods
npx @gscdump/cli compare --site https://example.com --period 28d

# Run SEO analysis
npx @gscdump/cli analyze striking-distance --site https://example.com
```

### Commands

| Command | Description |
|---------|-------------|
| `init` | First-run setup (choose cloud/local mode) |
| `auth` | OAuth2 login with Google |
| `sites` | List GSC properties |
| `dump` | Export analytics to stdout/file |
| `sync` | Persist to SQLite database |
| `compare` | Period-over-period comparison |
| `analyze` | Run SEO analysis (striking-distance, movers, decay, etc.) |
| `sitemaps` | List/manage sitemaps for a site |
| `index` | URL indexing (status, inspect, request) |
| `inspect` | Quick URL inspection |
| `config` | Manage CLI configuration |
| `mcp` | Start MCP server for AI assistants |

## MCP Server

Add to your Claude config (`~/.claude.json` or VS Code settings):

```json
{
  "mcpServers": {
    "gscdump": {
      "command": "npx",
      "args": ["@gscdump/mcp"]
    }
  }
}
```

Then ask Claude:

- "What pages lost traffic this week?"
- "Find keywords in striking distance (position 4-20)"
- "Which queries have keyword cannibalization?"
- "Compare this month vs last month"

The MCP server exposes tools for sites, pages, keywords, devices, countries, and analysis functions.

## API Usage

```ts
import { daysAgo, today } from '@gscdump/query'
import { fetchKeywordsWithComparison, fetchPagesWithComparison } from 'gscdump'

// Auth accepts token string or object
const auth = 'ya29.xxx...'
// or: { accessToken: 'ya29.xxx...' }

const range = {
  period: { start: daysAgo(28), end: today() },
}

// Pages with top keyword per page
const pages = await fetchPagesWithComparison(auth, site, range)

// Keywords with change percentages
const keywords = await fetchKeywordsWithComparison(auth, site, range)
```

### Streaming Large Datasets

For memory-efficient pagination of large datasets (>25k rows):

```ts
import { queryRecursiveStream } from 'gscdump'

// Stream keyword+page combinations - yields batches as they're fetched
for await (const batch of queryRecursiveStream(client, site, {
  dimensions: ['query', 'page'] as const, // as const required for type inference
  startDate: '2024-01-01',
  endDate: '2024-01-31',
})) {
  // batch: { keyword: string, page: string, clicks, impressions, ctr, position }[]
  await db.insert(batch)
}
```

### Analysis Functions

Analysis functions are pure - they operate on typed data arrays and return typed results.

```ts
import {
  analyzeCannibalization,
  analyzeDecay,
  analyzeMovers,
  analyzeStrikingDistance,
  fetchKeywordsWithComparison,
} from 'gscdump'

// Fetch data first
const { current, previous } = await fetchKeywordsWithComparison(auth, site, range)

// Run pure analysis on the data
const striking = analyzeStrikingDistance(current)
const movers = analyzeMovers(current, previous)
const decay = analyzeDecay(current, previous)
const cannibalization = analyzeCannibalization(keywordPageData)
```

### Typed Query Builder

Drizzle-style query builder with full type safety. Filter constraints flow through to result types.

```ts
import { and, between, contains, country, Country, date, device, Device, eq, gsc, inArray, page } from 'gscdump/query'

const body = gsc
  .select('page', 'query', 'device', 'country')
  .where(and(
    eq(device, Device.MOBILE),
    inArray(country, [Country.USA, Country.GBR]),
    contains(page, '/blog/')
  ))
  .where(between(date, '2024-01-01', '2024-01-31'))
  .toBody()

// Use with client.searchAnalytics.query(siteUrl, body)
```

**Operators:**

| Operator | Narrows Type? | Description |
|----------|---------------|-------------|
| `eq(col, val)` | ✓ | Exact match |
| `ne(col, val)` | ✗ | Not equal |
| `inArray(col, [a, b])` | ✓ | Value in array (becomes `a \| b`) |
| `contains(col, str)` | ✗ | String contains |
| `like(col, '%pattern%')` | ✗ | SQL LIKE pattern |
| `regex(col, /pattern/)` | ✗ | Regex match |
| `and(...filters)` | ✓ | Merge constraints |
| `or(...filters)` | ✗ | Any match |
| `not(filter)` | ✗ | Invert filter |

### All Exports

**Sites:** `fetchSites`, `fetchSitesWithSitemaps`, `fetchSitemaps`, `getSitemap`, `submitSitemap`, `deleteSitemap`, `inspectUrl`, `batchInspectUrls`

**Indexing:** `requestIndexing`, `getIndexingMetadata`, `batchRequestIndexing`

**Analytics:** `fetchAnalyticsWithComparison`, `fetchPagesWithComparison`, `fetchKeywordsWithComparison`, `fetchDevicesWithComparison`, `fetchCountriesWithComparison`, `fetchSearchAppearanceWithComparison`, `fetchDates`, `fetchDatesWithComparison`, `fetchPages`, `fetchPage`, `fetchKeyword`

**Analysis (Pure):** `analyzeStrikingDistance`, `analyzeOpportunity`, `analyzeBrandSegmentation`, `analyzeConcentration`, `analyzeDecay`, `analyzeMovers`, `analyzeCannibalization`, `analyzeZeroClick`, `analyzeSeasonality`, `analyzeClustering`

**Low-level:** `gscClient`, `queryRecursive`, `queryRecursiveStream`, `createQueryBody`, `withPropertyAggregation`, `withSearchAppearance`, `withDataType`, `withFreshData`, `withFinalData`

**Query Builder (`gscdump/query`):** `gsc`, `eq`, `ne`, `and`, `or`, `inArray`, `contains`, `like`, `regex`, `notRegex`, `not`, `page`, `query`, `device`, `country`, `searchAppearance`, `Device`, `Country`

**Error Utilities:** `isQuotaError`, `isRateLimitError`, `isAuthError`, `getErrorCode`, `getErrorMessage`, `getRetryAfter`, `analyzeGscError`, `formatGscErrorForCli`

**Utils:** `formatDateGsc`, `percentDifference`

## Auth Setup

**Cloud mode** (recommended):
```bash
npx @gscdump/cli init  # Select "cloud"
```
Easy setup via cloud.gscdump.com - no API keys needed.

**Local mode** (bring your own credentials):
1. Create a Google Cloud project
2. Enable "Search Console API" and "Web Search Indexing API"
3. Create OAuth2 credentials (Desktop app)
4. Run `npx @gscdump/cli init` and select "local"

## Packages

| Package | Description |
|---------|-------------|
| [`gscdump`](./packages/gscdump) | Core library - GSC API wrapper, analysis functions, query builder |
| [`@gscdump/cli`](./packages/cli) | CLI - dump, sync, compare, analyze, MCP server |
| [`@gscdump/mcp`](./packages/mcp) | MCP server - AI agents query your GSC data |
| [`@gscdump/db`](./packages/db) | SQLite persistence with Drizzle ORM |
| [`@gscdump/query`](./packages/query) | Data provider abstraction (API/DB unified interface) |

## License

[MIT](./LICENSE)
