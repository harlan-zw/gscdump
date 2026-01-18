# gscdump

[![npm version](https://img.shields.io/npm/v/gscdump?color=yellow)](https://npmjs.com/package/gscdump)
[![npm downloads](https://img.shields.io/npm/dm/gscdump?color=yellow)](https://npm.chart.dev/gscdump)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Google Search Console API wrapper with typed query builder, streaming pagination, and SEO analysis functions.

## Features

- **Typed Query Builder** - Drizzle-style API with filter constraints narrowing result types
- **Streaming Pagination** - Memory-efficient iteration over large datasets (>25k rows)
- **SEO Analysis** - Pure functions for cannibalization, striking distance, movers & shakers, decay detection
- **Edge-Compatible** - Works in Cloudflare Workers, Deno, and other edge runtimes
- **Full API Coverage** - Sites, sitemaps, indexing, and analytics

## Install

```bash
npm install gscdump
```

## Usage

```ts
import { fetchKeywordsWithComparison, fetchPagesWithComparison, userPeriodRange } from 'gscdump'

// Auth accepts token string or object
const auth = 'ya29.xxx...'
// or: { accessToken: 'ya29.xxx...' }

const range = userPeriodRange('28d')

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

### Typed Query Builder

Drizzle-style query builder with full type safety. Filter constraints flow through to result types.

```ts
import { and, contains, country, Country, device, Device, eq, gsc, inArray, page } from 'gscdump/query'

const result = await gsc
  .select('page', 'query', 'device', 'country')
  .where(and(
    eq(device, Device.MOBILE),
    inArray(country, [Country.USA, Country.GBR]),
    contains(page, '/blog/')
  ))
  .period('2024-01-01', '2024-01-31')
  .siteUrl('https://example.com')
  .execute(client)

// Fully typed results - narrowed by filters
result.rows[0].device // type: 'MOBILE' (narrowed by eq)
result.rows[0].country // type: 'usa' | 'gbr' (narrowed by inArray)
result.rows[0].page // type: string (contains doesn't narrow)
result.rows[0].clicks // type: number
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

## Exports

**Sites:** `fetchSites`, `fetchSitesWithSitemaps`, `fetchSitemaps`, `getSitemap`, `submitSitemap`, `deleteSitemap`, `inspectUrl`, `batchInspectUrls`

**Indexing:** `requestIndexing`, `getIndexingMetadata`, `batchRequestIndexing`

**Analytics:** `fetchAnalyticsWithComparison`, `fetchPagesWithComparison`, `fetchKeywordsWithComparison`, `fetchDevicesWithComparison`, `fetchCountriesWithComparison`, `fetchSearchAppearanceWithComparison`, `fetchDates`, `fetchDatesWithComparison`, `fetchPages`, `fetchPage`, `fetchKeyword`

**Analysis (Pure):** `analyzeStrikingDistance`, `analyzeOpportunity`, `analyzeBrandSegmentation`, `analyzeConcentration`, `analyzeDecay`, `analyzeMovers`, `analyzeCannibalization`, `analyzeZeroClick`, `analyzeSeasonality`, `analyzeClustering`

**Low-level:** `gscClient`, `queryRecursive`, `queryRecursiveStream`, `createQueryBody`, `withPropertyAggregation`, `withSearchAppearance`, `withDataType`, `withFreshData`, `withFinalData`

**Query Builder (`gscdump/query`):** `gsc`, `eq`, `ne`, `and`, `or`, `inArray`, `contains`, `like`, `regex`, `notRegex`, `not`, `page`, `query`, `device`, `country`, `searchAppearance`, `Device`, `Country`

**Error Utilities:** `isQuotaError`, `isRateLimitError`, `isAuthError`, `getErrorCode`, `getErrorMessage`, `getRetryAfter`, `analyzeGscError`, `formatGscErrorForCli`

**Utils:** `userPeriodRange`, `formatDateGsc`, `percentDifference`

## Related Packages

- [`@gscdump/cli`](../cli) - CLI for dump, sync, compare, analyze
- [`@gscdump/mcp`](../mcp) - MCP server for AI agents
- [`@gscdump/db`](../db) - SQLite persistence
- [`@gscdump/query`](../query) - Unified data provider

## License

[MIT](../../LICENSE)
