# Architecture

## Monorepo Structure

```
gscdump/
├── packages/
│   ├── gscdump/          # Core library - GSC API wrapper
│   ├── cli/              # @gscdump/cli - Command-line interface
│   └── db/               # @gscdump/db - SQLite persistence with Drizzle
├── apps/
│   ├── gscdump.com/      # Nuxt web dashboard
│   └── cloud.gscdump.com/ # Nuxt cloud service (CLI auth, storage)
├── layers/
│   ├── auth/             # Nuxt layer - OAuth authentication
│   └── mcp/              # Nuxt layer - Model Context Protocol tools
└── pnpm-workspace.yaml   # Workspace config with catalogs
```

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
| `analyzeCannibalization(auth, site, opts?)` | Find queries ranking for multiple pages |
| `analyzeStrikingDistance(auth, site, opts?)` | Find high-impression, low-CTR opportunities |
| `fetchYoYComparison(auth, site, opts?)` | Year-over-year period comparison |
| `analyzeMoversAndShakers(auth, site, opts?)` | Detect significant ranking/traffic changes |
| `analyzeContentDecay(auth, site, opts?)` | Find pages losing traffic over time |
| `analyzeZeroClickQueries(auth, site, opts?)` | Find high-impression queries with low CTR |
| `analyzeBrandSegmentation(auth, site, opts)` | Segment keywords into brand vs non-brand |
| `analyzeQueryClustering(auth, site, opts?)` | Cluster keywords by intent/prefix |
| `analyzeTrafficConcentration(auth, site, opts?)` | Measure traffic distribution risk (Gini/HHI) |
| `analyzeSeasonality(auth, site, opts?)` | Detect seasonal traffic patterns |
| `analyzeOpportunityScore(auth, site, opts?)` | Score keywords by optimization potential |

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

**Analysis Algorithms:**

| Algorithm | Description | Key Options |
|-----------|-------------|-------------|
| `analyzeCannibalization` | Detects keywords ranking for multiple pages (cannibalizing each other) | `minImpressions`, `maxPositionSpread`, `minPages` |
| `analyzeStrikingDistance` | Finds keywords in positions 4-20 with high impressions (easy wins) | `minPosition`, `maxPosition`, `maxCtr` |
| `analyzeMoversAndShakers` | Categorizes queries into rising, declining, stable based on period comparison | `changeThreshold`, `comparePeriod` |
| `analyzeContentDecay` | Finds pages losing traffic compared to previous period | `threshold`, `minPreviousClicks` |
| `analyzeZeroClickQueries` | Identifies high-impression queries with very low CTR (SERP features) | `maxCtr`, `maxPosition` |
| `analyzeBrandSegmentation` | Separates brand vs non-brand traffic using provided brand terms | `brandTerms` (required), `minImpressions` |
| `analyzeQueryClustering` | Groups keywords by intent prefix ("how to", "best") or common word prefix | `clusterBy` ('intent'/'prefix'/'both'), `minClusterSize` |
| `analyzeTrafficConcentration` | Measures traffic concentration using Gini coefficient and HHI | `dimension` ('page'/'keyword'), `topN` |
| `analyzeSeasonality` | Detects monthly traffic patterns, identifies peaks/troughs | `metric` ('clicks'/'impressions') |
| `analyzeOpportunityScore` | Composite score combining position, impressions, CTR gap | `weights` (position/impressions/ctrGap) |

**Concentration Thresholds (HHI):**
- `<1500`: Low risk - traffic is well distributed
- `1500-2500`: Medium risk - moderate concentration
- `>2500`: High risk - over-reliance on few pages/keywords

### @gscdump/cli

Command-line interface built with citty.

```
packages/cli/src/
├── index.ts              # Main entry, command registration
├── auth.ts               # OAuth2 flows (local + cloud), getAuth() helper
├── config.ts             # Config file handling (mode, cloudUrl, defaults)
├── provider.ts           # Unified data source abstraction (API/DB/auto)
├── utils.ts              # Progress bars, CSV export, splash screen
└── commands/
    ├── init.ts           # First-run setup (cloud/local mode selection)
    ├── dump.ts           # Export to JSON/CSV
    ├── sync.ts           # Sync to SQLite database
    ├── compare.ts        # Compare periods
    ├── sites.ts          # List GSC properties
    ├── sitemaps.ts       # Sitemap management
    ├── indexing.ts       # URL indexing management (index subcommand)
    ├── auth.ts           # Auth status/logout
    └── config.ts         # Config management
```

**Commands:**

| Command | Purpose |
|---------|---------|
| `gscdump init` | First-run setup (choose cloud/local mode) |
| `gscdump` | Interactive dump (default) |
| `gscdump dump -s site -d pages,keywords -p 90d` | Non-interactive export |
| `gscdump sync -s site` | Sync data to SQLite |
| `gscdump compare -s site` | Compare two periods |
| `gscdump sites` | List available sites |
| `gscdump sitemaps -s site` | List/manage sitemaps |
| `gscdump index status -s site` | Show indexing status from DB |
| `gscdump index inspect -s site` | Inspect URLs via GSC API |
| `gscdump index request -s site` | Request indexing via Indexing API |
| `gscdump inspect -s site -u url` | Quick URL inspection |
| `gscdump auth status` | Show auth status |
| `gscdump auth logout` | Clear tokens |
| `gscdump config set key value` | Set config |

**Auth Modes:**
- **Cloud**: Easy setup via cloud.gscdump.com (no API keys needed)
- **Local**: Use your own Google OAuth credentials

**Config (`~/.config/gscdump/config.json`):**
// ~/.config/gscdump/config.json
{
  "mode": "cloud",
  "cloudUrl": "https://cloud.gscdump.com",
  "defaultSite": "sc-domain:example.com",
  "defaultPeriod": "90d",
  "defaultFormat": "json",
  "defaultDb": "./data.db"
}

### @gscdump/db

SQLite/D1 persistence layer with Drizzle ORM.

```
packages/db/src/
├── index.ts          # Re-exports all (includes gscdump dep)
├── cloud.ts          # Cloud-only exports (no gscdump dep)
├── connector.ts      # Database connection setup
├── schema.ts         # Drizzle schema definitions
├── queries.ts        # Query helpers (trends, rollups, changes)
├── cloud-queries.ts  # Cloud-specific queries (users, cli_auth_codes, sessions)
├── sync.ts           # GSC → SQLite sync functions
└── api-queries.ts    # DB-backed query functions (mirrors gscdump API)
```

**Exports:**
- `@gscdump/db` - Full package (includes sync functions that depend on gscdump)
- `@gscdump/db/cloud` - Cloud-only (schema + cloud queries, no gscdump dependency)

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
| `keywords` | Keyword metadata (optional enrichment) |
| `users` | OAuth users (cloud) |
| `cli_auth_codes` | CLI device auth codes (cloud) |
| `cli_sessions` | CLI session tracking (cloud) |
| `user_sites` | User-site associations (cloud) |

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
| `inspectAndSyncUrl(db, auth, siteId, property, path)` | Inspect URL and save status to DB |
| `requestAndSyncIndexing(db, auth, siteId, property, path, type?)` | Request indexing and save to DB |
| `batchInspectUrls(db, auth, siteId, property, paths, opts?)` | Batch inspect URLs with progress |
| `batchRequestIndexingForPaths(db, auth, siteId, property, paths, opts?)` | Batch request indexing with progress |
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

**Cloud Query Functions:**

| Function | Purpose |
|----------|---------|
| `createCliAuthCode(db, data)` | Create CLI auth code |
| `getCliAuthCode(db, code)` | Get auth code by code |
| `updateCliAuthCode(db, code, data)` | Update auth code |
| `deleteCliAuthCode(db, code)` | Delete auth code |
| `deleteExpiredCliAuthCodes(db)` | Cleanup expired codes |
| `completeCliAuthCode(db, code, tokens)` | Complete auth with tokens |
| `getUserByGoogleId(db, googleId)` | Get user by Google ID |
| `getUserByEmail(db, email)` | Get user by email |
| `getUserById(db, userId)` | Get user by ID |
| `createUser(db, data)` | Create new user |
| `updateUser(db, userId, data)` | Update user |
| `upsertUser(db, data)` | Create or update user |
| `updateUserTokens(db, userId, tokens)` | Update user OAuth tokens |
| `createCliSession(db, data)` | Create CLI session |
| `getCliSession(db, sessionId)` | Get session by ID |
| `getUserSessions(db, userId)` | Get user's sessions |
| `updateSessionLastUsed(db, sessionId)` | Update session activity |
| `revokeCliSession(db, sessionId)` | Revoke single session |
| `revokeAllUserSessions(db, userId)` | Revoke all user sessions |
| `getUserSessionStats(db, userId)` | Get session statistics |

## Apps

### gscdump.com
Main web dashboard for GSC data visualization.

```
apps/gscdump.com/
├── app/
│   ├── app.vue
│   ├── components/
│   │   └── PerformanceChart.vue
│   ├── middleware/
│   │   └── auth.ts
│   └── pages/
│       ├── index.vue         # Landing page
│       ├── dashboard.vue     # User dashboard
│       └── sites/
│           ├── [siteUrl].vue # Site overview
│           └── [siteUrl]/
│               ├── index.vue     # Site dashboard
│               ├── pages.vue     # Pages list
│               ├── page.vue      # Single page details
│               ├── keywords.vue  # Keywords list
│               ├── keyword.vue   # Single keyword details
│               ├── countries.vue # Country breakdown
│               └── devices.vue   # Device breakdown
├── server/
│   └── ...
└── nuxt.config.ts
```

### cloud.gscdump.com
Cloud service for CLI authentication. Deployed to **Cloudflare Workers** with D1 database.

```
apps/cloud.gscdump.com/
├── app/
│   ├── app.vue
│   ├── components/
│   │   └── PerformanceChart.vue
│   ├── middleware/
│   │   └── auth.ts
│   └── pages/
│       ├── index.vue         # Landing page
│       ├── dashboard.vue     # User dashboard
│       └── cli/
│           └── auth.vue      # CLI authorization page
├── server/
│   ├── api/
│   │   ├── cli/auth/
│   │   │   ├── init.post.ts      # Start CLI auth flow
│   │   │   ├── poll.get.ts       # Poll for auth completion
│   │   │   └── complete.post.ts  # Complete auth after OAuth
│   │   └── user/...              # User API endpoints
│   ├── routes/auth/
│   │   └── google.get.ts     # OAuth callback
│   ├── types/...
│   └── utils/
│       ├── db.ts             # D1 database connection
│       └── ...
├── migrations/
│   ├── 0001_init.sql         # D1 schema (users, cli_auth_codes, sites)
│   └── 0002_cli_sessions.sql # CLI sessions
├── wrangler.toml             # Cloudflare config
└── nuxt.config.ts            # cloudflare-durable preset
```

**Infrastructure:**
- Nitro preset: `cloudflare-durable`
- Database: Cloudflare D1 (`gscdump-db`)
- Uses `gscdump` package directly (edge-compatible)

**CLI Auth Flow:**
1. CLI calls `POST /api/cli/auth/init` → returns `{ code, authUrl }`
2. User visits `authUrl`, signs in with Google OAuth
3. CLI polls `GET /api/cli/auth/poll?code=xxx` until complete
4. CLI receives tokens and saves them locally

## Nuxt Layers

### auth

OAuth2 authentication layer for Nuxt apps.

```
layers/auth/
├── nuxt.config.ts
└── server/
    ├── routes/auth/google.get.ts   # OAuth callback
    ├── types/auth.d.ts             # Session type augmentation
    └── utils/gsc-auth.ts           # Auth utilities
```

### mcp

Model Context Protocol tools for AI integrations.

```
layers/mcp/
├── nuxt.config.ts
└── server/mcp/
    ├── index.ts
    └── tools/
        ├── list-sites.ts
        ├── list-sites-with-sitemaps.ts
        ├── get-analytics.ts
        ├── get-pages.ts
        ├── get-keywords.ts
        ├── get-keyword-details.ts
        ├── get-page-details.ts
        ├── get-countries.ts
        ├── get-devices.ts
        └── inspect-url.ts
```

## Data Flow

```
GscAuth (access token)
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│                    gscdump (core)                       │
│  core/client.ts: gscClient (ofetch, edge-compatible)    │
│  api/: sites, indexing, inspection, search-analytics/   │
│  analysis/: cannibalization, decay, movers, etc         │
│  query/: fluent query builder                           │
└─────────────────────────────────────────────────────────┘
     │                    │                    │
     ▼                    ▼                    ▼
┌────────────────┐ ┌────────────────┐ ┌──────────────────┐
│  @gscdump/cli  │ │  @gscdump/db   │ │ cloud.gscdump.com│
│  dump → JSON   │ │  sync → SQLite │ │  Cloudflare D1   │
│  dump → CSV    │ │  (drizzle-orm) │ │  (edge runtime)  │
└────────────────┘ └────────────────┘ └──────────────────┘
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

### Data Provider Abstraction

CLI uses a unified `DataProvider` interface to fetch data from API or DB:

```ts
const provider = await createProvider({
  auth,
  db,
  source: 'auto', // 'api' | 'db' | 'auto'
  siteUrls,
  range,
})

// Same interface regardless of source
const pages = await provider.getPagesWithComparison(siteUrl, range)
```

`auto` mode checks DB for data availability, falls back to API.

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
import { query, eq, gt, contains } from 'gscdump'

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

### @gscdump/db

| Package | Purpose |
|---------|---------|
| `drizzle-orm` | SQLite/D1 ORM |
| `db0` | Database connector |

### @gscdump/cli

| Package | Purpose |
|---------|---------|
| `google-auth-library` | OAuth2 flows |
| `citty` | CLI framework |
| `@clack/prompts` | Interactive prompts |
| `consola` | Logging |

## Build System

- **obuild**: TypeScript build tool for all packages
- **pnpm catalogs**: Centralized dependency versions in `pnpm-workspace.yaml`
- **ESM only**: All packages use `"type": "module"`
