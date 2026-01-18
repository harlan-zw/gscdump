# Architecture

## Monorepo Structure

```
gscdump/
├── packages/
│   ├── gscdump/          # Core library - GSC API wrapper
│   ├── cli/              # @gscdump/cli - Command-line interface
│   ├── db/               # @gscdump/db - SQLite persistence with Drizzle
│   ├── query/            # @gscdump/query - Data provider abstraction
│   └── mcp/              # @gscdump/mcp - MCP server for AI assistants
└── pnpm-workspace.yaml   # Workspace config with catalogs
```

Web app lives separately at https://github.com/harlan-zw/gscdump.com

## Packages

### gscdump (Core Library)

Google Search Console API wrapper. Pure functions, no persistence. **Edge-compatible** (works in Cloudflare Workers, Deno, etc).

```
packages/gscdump/src/
├── index.ts              # Public API exports
├── core/
│   ├── client.ts         # ofetch-based GSC/Indexing API client
│   ├── errors.ts         # Error handling utilities
│   └── types.ts          # Core TypeScript interfaces
├── api/
│   ├── index.ts          # API exports
│   ├── sites.ts          # Site listing APIs
│   ├── indexing.ts       # Indexing API requests
│   ├── inspection.ts     # URL inspection APIs
│   └── search-analytics/
│       ├── index.ts      # Search analytics exports
│       ├── analytics.ts  # Site-level analytics
│       ├── breakdowns.ts # Country/device/appearance breakdowns
│       ├── dates.ts      # Daily metrics
│       ├── keywords.ts   # Keyword fetching
│       ├── pages.ts      # Page fetching
│       ├── query.ts      # Query body builder
│       ├── stream.ts     # Streaming/async iteration
│       ├── types.ts      # Analytics types
│       └── utils.ts      # Period/range utilities
├── analysis/
│   ├── index.ts          # Analysis exports
│   ├── types.ts          # Analysis types
│   ├── brand.ts          # Brand segmentation
│   ├── cannibalization.ts# Keyword cannibalization
│   ├── clustering.ts     # Query clustering
│   ├── concentration.ts  # Traffic concentration (Gini/HHI)
│   ├── decay.ts          # Content decay detection
│   ├── movers.ts         # Movers and shakers
│   ├── opportunity.ts    # Opportunity scoring
│   ├── seasonality.ts    # Seasonal patterns
│   ├── striking-distance.ts # Striking distance keywords
│   └── zero-click.ts     # Zero-click query detection
├── query/
│   ├── index.ts          # Query builder exports
│   ├── builder.ts        # Fluent query builder
│   ├── columns.ts        # Column definitions
│   ├── constants.ts      # Query constants
│   ├── operators.ts      # Filter operators
│   ├── resolver.ts       # Query resolution
│   └── types.ts          # Query types
└── utils/
    ├── countries.ts      # ISO country code mappings
    ├── dayjs.ts          # Configured dayjs with timezone
    └── format.ts         # Date formatting & period resolution
```

**Authentication:**

```ts
// GscAuth accepts token string or object
type GscAuth = string | { accessToken: string }

// Usage
const sites = await fetchSites('ya29.xxx...')
// or
const sites = await fetchSites({ accessToken: 'ya29.xxx...' })
```

**Key Exports:**

| Function | Purpose |
|----------|---------|
| `gscClient` | Low-level ofetch API client |
| `fetchSites(auth)` | List all GSC properties |
| `fetchSitesWithSitemaps(auth)` | Properties + sitemap data |
| `fetchSitemaps(auth, siteUrl)` | Get sitemaps for a site |
| `getSitemap(auth, siteUrl, feedpath)` | Get single sitemap |
| `submitSitemap(auth, siteUrl, feedpath)` | Submit new sitemap |
| `deleteSitemap(auth, siteUrl, feedpath)` | Delete sitemap |
| `inspectUrl(auth, property, url)` | Check URL indexing status |
| `batchInspectUrls(auth, property, urls)` | Batch inspect URLs |
| `requestIndexing(auth, url, type?)` | Request indexing via Indexing API |
| `getIndexingMetadata(auth, url)` | Get indexing notification metadata |
| `batchRequestIndexing(auth, urls, opts?)` | Batch indexing requests with rate limiting |
| `queryRecursive(api, query)` | Paginated query (25k/page) |
| `fetchDates(auth, range, site)` | Daily metrics |
| `fetchDatesWithComparison(...)` | Daily metrics + period comparison |
| `fetchAnalyticsWithComparison(...)` | Site summary + period comparison |
| `fetchPages(auth, range, site)` | All pages with performance |
| `fetchPagesWithComparison(...)` | Pages + period comparison |
| `fetchKeywordsWithComparison(...)` | Keywords + period comparison |
| `fetchCountriesWithComparison(...)` | Countries + keyword counts |
| `fetchDevicesWithComparison(...)` | Device breakdown |
| `fetchSearchAppearanceWithComparison(...)` | Search appearance breakdown |
| `fetchKeyword(auth, range, site, kw)` | Single keyword drill-down |
| `fetchPage(auth, range, site, url)` | Single page drill-down |
| `createQueryBody(opts)` | Build GSC query request body |
| `withSearchAppearance(appearance)` | Filter by search appearance |
| `withDataType(type)` | Filter by data type |
| `withFreshData()` | Request fresh (unfinalized) data |
| `withFinalData()` | Request finalized data only |
| `withPropertyAggregation()` | Use byProperty aggregation for domain totals |

**Error Utilities:**

| Function | Purpose |
|----------|---------|
| `isQuotaError(error)` | Check if error is quota exceeded |
| `isRateLimitError(error)` | Check if error is rate limit |
| `isAuthError(error)` | Check if error is auth failure |
| `getErrorCode(error)` | Extract HTTP status code |
| `getErrorMessage(error)` | Extract error message |
| `getRetryAfter(error)` | Get retry-after seconds |
| `analyzeGscError(error)` | Full error analysis |
| `formatGscErrorForCli(error)` | CLI-friendly error message |

**Analysis Functions (Pure):**

All analysis functions are pure - they operate on typed data arrays and return typed results. No API calls.

| Function | Purpose |
|----------|---------|
| `analyzeStrikingDistance(data, opts?)` | Find keywords in positions 4-20 with high impressions |
| `analyzeOpportunity(data, opts?)` | Score keywords by optimization potential |
| `analyzeBrandSegmentation(data, opts)` | Segment keywords into brand vs non-brand |
| `analyzeConcentration(data, opts?)` | Measure traffic distribution risk (Gini/HHI) |
| `analyzePageConcentration(...)` | Concentration analysis for pages |
| `analyzeKeywordConcentration(...)` | Concentration analysis for keywords |
| `analyzeDecay(current, previous, opts?)` | Find pages losing traffic over time |
| `analyzeMovers(current, previous, opts?)` | Detect significant ranking/traffic changes |
| `analyzeCannibalization(data, opts?)` | Find queries ranking for multiple pages |
| `analyzeZeroClick(data, opts?)` | Find high-impression queries with low CTR |
| `analyzeSeasonality(data, opts?)` | Detect monthly traffic patterns |
| `analyzeClustering(data, opts?)` | Cluster keywords by intent/prefix |

**Concentration Thresholds (HHI):**
- `<1500`: Low risk - traffic is well distributed
- `1500-2500`: Medium risk - moderate concentration
- `>2500`: High risk - over-reliance on few pages/keywords

### @gscdump/query

Data provider abstraction layer. Provides unified interface to fetch data from API or DB.

```
packages/query/src/
├── index.ts          # Re-exports all
├── types.ts          # Provider types
├── factory.ts        # createProvider factory
├── api-provider.ts   # API-backed provider
├── db-provider.ts    # DB-backed provider
└── analysis/
    ├── index.ts      # Re-exports gscdump analysis + fetch wrappers
    ├── types.ts      # Provider-specific types
    └── fetch.ts      # Provider-based fetch wrappers
```

**Provider Pattern:**

```ts
const provider = await createProvider({
  auth,
  db, // optional
  source: 'auto', // 'api' | 'db' | 'auto'
  siteUrls: ['sc-domain:example.com'],
  range,
})

// Same interface regardless of source
const pages = await provider.getPagesWithComparison(siteUrl, range)
const keywords = await provider.getKeywordsWithComparison(siteUrl, range)
```

`auto` mode checks DB for data availability, falls back to API.

**Analysis Fetch Wrappers:**

Provider-based wrappers that fetch data and run analysis:

| Function | Purpose |
|----------|---------|
| `fetchStrikingDistanceAnalysis(provider, site, range, opts?)` | Fetch keywords + run striking distance analysis |
| `fetchOpportunityAnalysis(provider, site, range, opts?)` | Fetch keywords + run opportunity scoring |
| `fetchBrandAnalysis(provider, site, range, opts)` | Fetch keywords + brand segmentation |
| `fetchMoversAnalysis(provider, site, range, opts?)` | Fetch comparison data + movers analysis |
| `fetchDecayAnalysis(provider, site, range, opts?)` | Fetch comparison data + decay detection |
| `fetchCannibalizationAnalysis(provider, site, range, opts?)` | Fetch keyword-page data + cannibalization |
| `fetchZeroClickAnalysis(provider, site, range, opts?)` | Fetch keywords + zero-click detection |
| `fetchSeasonalityAnalysis(provider, site, range, opts?)` | Fetch daily data + seasonality analysis |
| `fetchPageConcentrationAnalysis(provider, site, range, opts?)` | Fetch pages + concentration |
| `fetchKeywordConcentrationAnalysis(provider, site, range, opts?)` | Fetch keywords + concentration |

### @gscdump/mcp

MCP (Model Context Protocol) server for AI assistant integration.

```
packages/mcp/src/
├── index.ts          # Re-exports handlers + types
├── types.ts          # Zod schemas for tool inputs
├── server/
│   └── index.ts      # createGscMcpServer factory
└── handlers/
    ├── index.ts      # Handler exports
    ├── sites.ts      # Site/sitemap handlers
    ├── analytics.ts  # Analytics fetch handlers
    ├── indexing.ts   # URL inspection/indexing handlers
    ├── analysis.ts   # Analysis handlers
    ├── query.ts      # Custom query handler
    └── utils.ts      # Period parsing utilities
```

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `list-sites` | List all GSC properties |
| `list-sites-with-sitemaps` | List sites with sitemap data |
| `list-sitemaps` | List sitemaps for a site |
| `get-sitemap` | Get sitemap details |
| `submit-sitemap` | Submit new sitemap |
| `delete-sitemap` | Delete sitemap |
| `fetch-dates` | Daily search analytics |
| `fetch-devices` | Device breakdown |
| `fetch-countries` | Country breakdown |
| `fetch-pages` | All pages with performance |
| `fetch-pages-comparison` | Pages with period comparison |
| `fetch-keywords` | Keywords with comparison |
| `fetch-search-appearance` | Search appearance breakdown |
| `fetch-page-details` | Single page drill-down |
| `fetch-keyword-details` | Single keyword drill-down |
| `fetch-analytics-summary` | Site summary with comparison |
| `inspect-url` | URL indexing status |
| `request-indexing` | Request URL indexing |
| `get-indexing-status` | Indexing metadata |
| `batch-request-indexing` | Batch indexing requests |
| `batch-inspect-urls` | Batch URL inspection |
| `detect-cannibalization` | Keyword cannibalization analysis |
| `find-striking-distance` | Quick-win keywords |
| `fetch-yoy-comparison` | Year-over-year comparison |
| `analyze-movers-and-shakers` | Rising/declining queries |
| `detect-content-decay` | Decaying content detection |
| `find-zero-click-queries` | Zero-click query detection |
| `custom-query` | Execute custom GSC query |
| `parse-period` | Parse period strings to date ranges |

**Usage:**

```ts
import { createGscMcpServer } from '@gscdump/mcp/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = createGscMcpServer({
  name: 'gscdump',
  version: '1.0.0',
  getAuth: () => getAuth(),
  getDb: () => db, // optional
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

### @gscdump/cli

Command-line interface built with citty.

```
packages/cli/src/
├── index.ts              # Main entry, command registration
├── auth.ts               # OAuth2 flows (local + cloud), getAuth() helper
├── config.ts             # Config file handling (mode, cloudUrl, defaults)
├── utils.ts              # Progress bars, CSV export, splash screen
└── commands/
    ├── init.ts           # First-run setup (cloud/local mode selection)
    ├── dump.ts           # Export to JSON/CSV
    ├── sync.ts           # Sync to SQLite database
    ├── compare.ts        # Compare periods
    ├── analyze.ts        # Run SEO analysis
    ├── sites.ts          # List GSC properties
    ├── sitemaps.ts       # Sitemap management
    ├── indexing.ts       # URL indexing management (index/inspect)
    ├── auth.ts           # Auth status/logout
    ├── config.ts         # Config management
    └── mcp.ts            # Start MCP server
```

**Commands:**

| Command | Purpose |
|---------|---------|
| `gscdump init` | First-run setup (choose cloud/local mode) |
| `gscdump` | Interactive dump (default) |
| `gscdump dump -s site -d pages,keywords -p 90d` | Non-interactive export |
| `gscdump sync -s site` | Sync data to SQLite |
| `gscdump compare -s site` | Compare two periods |
| `gscdump analyze <type> -s site` | Run SEO analysis |
| `gscdump sites` | List available sites |
| `gscdump sitemaps -s site` | List/manage sitemaps |
| `gscdump index status -s site` | Show indexing status from DB |
| `gscdump index inspect -s site` | Inspect URLs via GSC API |
| `gscdump index request -s site` | Request indexing via Indexing API |
| `gscdump inspect -s site -u url` | Quick URL inspection |
| `gscdump auth status` | Show auth status |
| `gscdump auth logout` | Clear tokens |
| `gscdump config set key value` | Set config |
| `gscdump mcp` | Start MCP server for AI assistants |

**Analysis Types:**

```bash
gscdump analyze striking-distance -s sc-domain:example.com
gscdump analyze opportunity -s sc-domain:example.com
gscdump analyze movers -s sc-domain:example.com
gscdump analyze decay -s sc-domain:example.com
gscdump analyze cannibalization -s sc-domain:example.com
gscdump analyze zero-click -s sc-domain:example.com
```

**Auth Modes:**
- **Cloud**: Easy setup via cloud.gscdump.com (no API keys needed)
- **Local**: Use your own Google OAuth credentials

**Config (`~/.config/gscdump/config.json`):**
```json
{
  "mode": "cloud",
  "cloudUrl": "https://cloud.gscdump.com",
  "defaultSite": "sc-domain:example.com",
  "defaultPeriod": "90d",
  "defaultFormat": "json",
  "defaultDb": "./data.db"
}
```

### @gscdump/db

SQLite persistence layer with Drizzle ORM.

```
packages/db/src/
├── index.ts          # Re-exports all
├── setup.ts          # createGscDb factory
├── connector.ts      # Database connection setup
├── schema.ts         # Drizzle schema definitions
├── queries.ts        # Query helpers (trends, rollups, changes)
├── sync.ts           # GSC → SQLite sync functions
└── api-queries.ts    # DB-backed query functions (mirrors gscdump API)
```

**Schema Tables:**

| Table | Purpose |
|-------|---------|
| `sites` | GSC properties (property, domain, sitemaps) |
| `site_paths` | URLs/pages per site |
| `site_path_indexing` | URL indexing status and request tracking |
| `site_sitemaps` | Sitemap metadata |
| `site_date_analytics` | Daily site-level metrics |
| `site_path_date_analytics` | Daily page-level metrics |
| `site_keyword_date_analytics` | Daily keyword metrics |
| `site_keyword_path_date_analytics` | Keyword × page (most granular) |
| `site_date_country_analytics` | Daily country metrics |
| `site_date_device_analytics` | Daily device metrics |
| `site_date_search_appearance_analytics` | Daily search appearance metrics |

**Sync Functions:**

| Function | Purpose |
|----------|---------|
| `syncSites(db, auth)` | Sync all GSC properties |
| `syncPages(db, auth, siteId, site, range)` | Sync page analytics |
| `syncKeywords(...)` | Sync keyword analytics |
| `syncKeywordPaths(...)` | Sync keyword×page data |
| `syncCountries(...)` | Sync country analytics |
| `syncDevices(...)` | Sync device analytics |
| `syncAll(...)` | Sync all data types |
| `syncAllWithKeywordPaths(...)` | Sync all including granular |
| `updateLastSynced(db, siteId)` | Update site's lastSynced timestamp |
| `inspectAndSyncUrl(db, auth, siteId, property, path)` | Inspect URL and save status |
| `requestAndSyncIndexing(...)` | Request indexing and save to DB |
| `batchInspectUrls(...)` | Batch inspect URLs with progress |
| `batchRequestIndexingForPaths(...)` | Batch request indexing with progress |
| `getIndexingStats(db, siteId)` | Get indexing status summary |
| `getUrlsNeedingIndexing(db, siteId, opts?)` | Query URLs needing indexing |

**Query Functions:**

| Function | Purpose |
|----------|---------|
| `getSiteByProperty(db, property)` | Get site by property URL |
| `getSiteById(db, siteId)` | Get site by ID |
| `getAllSites(db)` | List all sites |
| `getPageTrend(db, siteId, path, start, end)` | Single page trend |
| `getTopPages(db, siteId, start, end, limit)` | Top pages by clicks |
| `getKeywordTrend(db, siteId, keyword, start, end)` | Single keyword trend |
| `getTopKeywords(db, siteId, start, end, limit)` | Top keywords by clicks |
| `getSiteDailyTotals(db, siteId, start, end)` | Site daily aggregates |
| `getCountryBreakdown(db, siteId, start, end)` | Country breakdown |
| `getDeviceBreakdown(db, siteId, start, end)` | Device breakdown |
| `comparePeriods(db, siteId, current, previous)` | Compare two periods |
| `queryWeeklyRollup(db, siteId, start, end)` | Aggregate by week |
| `queryMonthlyRollup(db, siteId, start, end)` | Aggregate by month |
| `findSignificantChanges(db, siteId, ...)` | Detect ranking changes |
| `findLostPages(db, siteId, ...)` | Find pages that disappeared |
| `findNewPages(db, siteId, ...)` | Find newly appearing pages |
| `pruneOldData(db, cutoffDate)` | Delete data before date |
| `pruneOldDataByDays(db, siteId, days)` | Delete data older than N days |
| `vacuumDb(db)` | Reclaim disk space |

**API Query Functions** (read from DB instead of API):

| Function | Purpose |
|----------|---------|
| `queryDatesWithComparison(db, siteId, current, previous?)` | Daily metrics from DB |
| `queryPagesWithComparison(db, siteId, current, previous?)` | Pages with comparison from DB |
| `queryKeywordsWithComparison(db, siteId, current, previous?)` | Keywords with comparison from DB |
| `queryDevicesWithComparison(db, siteId, current, previous?)` | Device breakdown from DB |
| `queryCountriesWithComparison(db, siteId, current, previous?)` | Country breakdown from DB |
| `queryPages(db, siteId, range)` | Simple page list from DB |
| `queryKeyword(db, siteId, range, keyword)` | Keyword drill-down from DB |
| `queryPage(db, siteId, range, path)` | Page drill-down from DB |
| `hasDataForRange(db, siteId, range)` | Check if DB has data for range |

## Data Flow

```
GscAuth (access token)
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│                    gscdump (core)                       │
│  core/client.ts: gscClient (ofetch, edge-compatible)    │
│  api/: sites, indexing, inspection, search-analytics/   │
│  analysis/: pure functions (no API calls)               │
│  query/: fluent query builder                           │
└─────────────────────────────────────────────────────────┘
     │                    │                    │
     ▼                    ▼                    ▼
┌────────────────┐ ┌────────────────┐ ┌────────────────────┐
│ @gscdump/query │ │  @gscdump/db   │ │   @gscdump/mcp     │
│ API/DB provider│ │  sync → SQLite │ │   MCP server       │
│ analysis fetch │ │  (drizzle-orm) │ │   for AI tools     │
└────────────────┘ └────────────────┘ └────────────────────┘
         │                 │                    │
         └─────────────────┼────────────────────┘
                           ▼
                  ┌────────────────┐
                  │  @gscdump/cli  │
                  │  dump → JSON   │
                  │  sync → SQLite │
                  │  analyze → SEO │
                  │  mcp → server  │
                  └────────────────┘
```

## Key Patterns

### Recursive Pagination

GSC limits responses to 25k rows. `queryRecursive()` handles this:

```ts
const { data, pages } = await queryRecursive(api, query)
// data.rows contains ALL results across pages
```

### Period Comparison

All `*WithComparison` functions return:

```ts
interface ComparisonResult<T> {
  current: T[] // Current period data
  previous: T[] // Previous period data
  metadata: {
    currentCount: number
    previousCount: number
    // ...
  }
}
```

### Query Builder

The `query/` module provides a fluent query builder for GSC Search Analytics API:

**Low-level:** `createQueryBody()` applies standard defaults:
- Excludes URLs with `#` (fragments)
- 25k row limit
- byPage aggregation
- all data states
- Optional domain filtering via regex

**Fluent builder:** `query()` for complex queries:
```ts
import { contains, eq, gt, query } from 'gscdump'

const results = await query(auth, site)
  .select('query', 'page', 'clicks', 'impressions')
  .where(gt('clicks', 10), contains('query', 'seo'))
  .groupBy('query')
  .orderBy('clicks', 'desc')
  .limit(100)
  .execute()
```

### Metric Storage

Database stores floats as integers for precision:
- `ctr`: stored as `ctr * 10000`
- `position`: stored as `position * 100`

### Error Handling

Uses `.catch()` on promises per project convention. No try/catch blocks.

## Dependencies

### gscdump (core)

| Package | Purpose |
|---------|---------|
| `ofetch` | HTTP client (edge-compatible) |
| `dayjs` | Date manipulation |
| `ufo` | URL utilities |
| `@googleapis/searchconsole` | Types only (devDep) |
| `@googleapis/indexing` | Types only (devDep) |

### @gscdump/query

| Package | Purpose |
|---------|---------|
| `gscdump` | Core library |
| `@gscdump/db` | Database provider |

### @gscdump/mcp

| Package | Purpose |
|---------|---------|
| `gscdump` | Core library |
| `@gscdump/query` | Data providers |
| `@modelcontextprotocol/sdk` | MCP SDK |
| `zod` | Schema validation |

### @gscdump/db

| Package | Purpose |
|---------|---------|
| `drizzle-orm` | SQLite ORM |
| `db0` | Database connector |

### @gscdump/cli

| Package | Purpose |
|---------|---------|
| `gscdump` | Core library |
| `@gscdump/db` | Database |
| `@gscdump/query` | Data providers |
| `@gscdump/mcp` | MCP server |
| `google-auth-library` | OAuth2 flows |
| `citty` | CLI framework |
| `@clack/prompts` | Interactive prompts |
| `consola` | Logging |

## Build System

- **unbuild**: TypeScript build tool for all packages
- **pnpm catalogs**: Centralized dependency versions in `pnpm-workspace.yaml`
- **ESM only**: All packages use `"type": "module"`
