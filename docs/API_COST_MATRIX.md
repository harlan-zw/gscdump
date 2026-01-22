# API Cost Matrix

This document maps all query and analysis functions to their API call costs.

## IMPORTANT: Pagination Behavior

**GSC API does NOT support offset/limit pagination for comparison queries.**

The comparison functions (`fetchPagesWithComparison`, `fetchKeywordsWithComparison`, etc.) are designed for **analysis**, not paginated display:

```ts
// ❌ WRONG - API doesn't support offset
fetchKeywordsWithComparison(client, siteUrl, {
  rowLimit: 50, // This limits total rows, NOT page size
  offset: 100 // ❌ NOT SUPPORTED
})

// ✅ CORRECT - Fetch top N, paginate client-side
const data = await fetchKeywordsWithComparison(client, siteUrl, {
  period: { start, end },
  rowLimit: 100, // Fetch top 100 by clicks
})
// Then slice for pagination
const page = data.current.slice(offset, offset + pageSize)
```

**For true server-side pagination with large datasets, use the DB provider:**
```ts
// DB provider supports SQL-level offset/limit
const provider = createDbProvider(db)
// ... but comparison queries still load all data first
```

### Query Builder vs API Functions

The query builder (`.offset()`, `.limit()`) is for **DB queries only**:

```ts
// ✅ DB - offset/limit work
gsc.where(...).offset(100).limit(50)  // SQL OFFSET/LIMIT

// ❌ API - query builder not used, pass options directly
fetchKeywordsWithComparison(client, siteUrl, {
  period: { start, end },
  rowLimit: 100,  // Max rows to fetch
})
```

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | API OK (≤3 calls) |
| ⚠️ | API Expensive (4-10 calls) |
| 🚫 | DB Only (>10 calls or unbounded) |
| N | Variable based on data size |

## Core Query Functions (packages/gscdump)

### Search Analytics Queries

| Function | API Calls | Notes | Recommendation |
|----------|-----------|-------|----------------|
| `fetchDates` | 1 | Single date dimension query | ✅ API OK |
| `fetchDatesWithComparison` | 2 | Current + previous period | ✅ API OK |
| `fetchYoYComparison` | 2 | Current + YoY period | ✅ API OK |
| `fetchPages` | 1-N | Uses `queryRecursive`, paginates at 25k | ⚠️ Depends on site size |
| `fetchPagesWithComparison` | 3 | Current pages + previous pages + query×page | ✅ API OK |
| `fetchKeywords` | 1-N | Uses `queryRecursive`, paginates at 25k | ⚠️ Depends on site size |
| `fetchKeywordsWithComparison` | 3 | Current + previous + page×query join | ✅ API OK |
| `fetchPage` (drilldown) | 2 | Dates for page + top keywords | ✅ API OK |
| `fetchKeyword` (drilldown) | 2 | Dates for keyword + top pages | ✅ API OK |
| `fetchDevices` | 1 | 3 rows max (desktop/mobile/tablet) | ✅ API OK |
| `fetchDevicesWithComparison` | 2 | Current + previous | ✅ API OK |
| `fetchCountries` | 1 | Top 5 countries | ✅ API OK |
| `fetchCountriesWithComparison` | 2 + N | Current + previous + 1 per country for keywords | ⚠️ 7 calls for top 5 |
| `fetchSearchAppearance` | 1 | Single query | ✅ API OK |
| `fetchSearchAppearanceWithComparison` | 2 | Current + previous | ✅ API OK |
| `queryRecursive` | 1-N | Paginates every 25k rows | 🚫 Unbounded |

### Site & Inspection APIs

| Function | API Calls | Notes | Recommendation |
|----------|-----------|-------|----------------|
| `fetchSites` | 1 | List all sites | ✅ API OK |
| `fetchSitemaps` | 1 | List sitemaps for site | ✅ API OK |
| `fetchSitemap` | 1 | Single sitemap details | ✅ API OK |
| `inspectUrl` | 1 | Single URL inspection | ✅ API OK |
| `batchInspectUrls` | N | 1 per URL (rate limited) | 🚫 DB Only |
| `requestIndexing` | 1 | Single indexing request | ✅ API OK |
| `batchRequestIndexing` | N | 1 per URL (strict quota: 200/day) | 🚫 DB Only |

## Provider Functions (packages/query)

### DataProvider Interface

| Method | API Calls | Notes | Recommendation |
|--------|-----------|-------|----------------|
| `getDatesWithComparison` | 2 | Delegates to core | ✅ API OK |
| `getPages` | 1-N | Delegates to core | ⚠️ Depends on site |
| `getPagesWithComparison` | 3 | Delegates to core | ✅ API OK |
| `getKeywordsWithComparison` | 3 | Delegates to core | ✅ API OK |
| `getCountriesWithComparison` | 7 | Delegates to core | ⚠️ Borderline |
| `getDevicesWithComparison` | 2 | Delegates to core | ✅ API OK |
| `getPage` | 2 | Delegates to core | ✅ API OK |
| `getKeyword` | 2 | Delegates to core | ✅ API OK |
| `getSearchAppearanceWithComparison` | 2 | API only | ✅ API OK |
| `getQueryPageRows` | 1-N | query×page dimension, can be huge | 🚫 DB Only |
| `getDateRows` | 1 | Simple date query | ✅ API OK |

## Analysis Functions (packages/query + gscdump)

| Analysis | Data Required | API Calls | Recommendation |
|----------|---------------|-----------|----------------|
| `analyzeStrikingDistance` | Keywords | 3 | ✅ API OK |
| `analyzeOpportunity` | Keywords | 3 | ✅ API OK |
| `analyzeBrandSegmentation` | Keywords | 3 | ✅ API OK |
| `analyzePageConcentration` | Pages | 3 | ✅ API OK |
| `analyzeKeywordConcentration` | Keywords | 3 | ✅ API OK |
| `analyzeDecay` | Pages (comparison) | 3 | ✅ API OK |
| `analyzeMovers` | Keywords (comparison) | 3 | ✅ API OK |
| `analyzeCannibalization` | Query×Page rows | 1-N | 🚫 DB Only |
| `analyzeZeroClick` | Query×Page rows | 1-N | 🚫 DB Only |
| `analyzeSeasonality` | Date rows | 1 | ✅ API OK |
| `analyzeClustering` | Keywords | 3 | ✅ API OK |

## Summary

### API-Safe Functions (≤3 calls)
- All comparison queries for dates, pages, keywords, devices, search appearance
- Single entity drilldowns (page details, keyword details)
- Simple analysis: striking distance, opportunity, brand, concentration, decay, movers, seasonality, clustering

### DB-Only Functions
- **`analyzeCannibalization`** - Requires query×page matrix (can be millions of rows)
- **`analyzeZeroClick`** - Requires query×page matrix
- **`batchInspectUrls`** - N calls, rate limited
- **`batchRequestIndexing`** - N calls, strict 200/day quota
- **`queryRecursive`** - Unbounded pagination

### Borderline (Consider Caching)
- **`fetchCountriesWithComparison`** - 7 calls (2 + 5 keyword counts)
- **`fetchPages`** / **`fetchKeywords`** - 1 call but can paginate for large sites

## Implementation Recommendations

1. **Add `dbOnly` flag to provider methods:**
```ts
export interface QueryMeta {
  apiCalls: number | 'N'
  dbOnly: boolean
}

export const queryMeta: Record<string, QueryMeta> = {
  getDatesWithComparison: { apiCalls: 2, dbOnly: false },
  getQueryPageRows: { apiCalls: 'N', dbOnly: true },
  // ...
}
```

2. **Hybrid provider should throw for DB-only queries without DB:**
```ts
getQueryPageRows: async () => {
  if (this.source === 'api')
    throw new Error('getQueryPageRows requires database. Run gscdump sync first.')
  return dbProvider.getQueryPageRows(...)
}
```

3. **UI should show "Requires sync" badge for DB-only analyses**

4. **Consider adding `estimatedCalls()` helper for dynamic cost estimation**
