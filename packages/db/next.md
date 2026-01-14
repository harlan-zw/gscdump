# @gscdump/db - Next Steps

## 1. db0 Connector Setup

Wire up db0 with drizzle for database connections.

```ts
// src/connector.ts
import { createDatabase } from 'db0'
import { drizzle } from 'db0/integrations/drizzle'
import * as schema from './schema'

export function createGscDb(connector: Connector) {
  const db0 = createDatabase(connector)
  return drizzle(db0, { schema })
}
```

**Supported connectors:**
- `db0/connectors/better-sqlite3` - Local SQLite
- `db0/connectors/libsql` - Turso/libSQL
- `db0/connectors/postgresql` - Postgres

## 2. Sync Functions

Functions to persist gscdump fetch results to database.

```ts
// src/sync.ts
import type { OAuth2Client } from 'google-auth-library'
import { fetchGscSites, fetchKeywordsWithComparison, fetchPagesWithComparison } from 'gscdump'

export async function syncSites(db: GscDb, auth: OAuth2Client) {
  const sites = await fetchGscSites(auth)
  // upsert to sites table
}

export async function syncPages(db: GscDb, auth: OAuth2Client, siteId: number, range: ResolvedAnalyticsRange) {
  const { current } = await fetchPagesWithComparison(auth, site, range)
  // upsert to sitePathDateAnalytics
}

export async function syncKeywords(db: GscDb, auth: OAuth2Client, siteId: number, range: ResolvedAnalyticsRange) {
  const { current } = await fetchKeywordsWithComparison(auth, site, range)
  // upsert to siteKeywordDateAnalytics
}

export async function syncCountries(db: GscDb, auth: OAuth2Client, siteId: number, range: ResolvedAnalyticsRange) {
  // ...
}

export async function syncDevices(db: GscDb, auth: OAuth2Client, siteId: number, range: ResolvedAnalyticsRange) {
  // ...
}

export async function syncAll(db: GscDb, auth: OAuth2Client, siteId: number, range: ResolvedAnalyticsRange) {
  await Promise.all([
    syncPages(db, auth, siteId, range),
    syncKeywords(db, auth, siteId, range),
    syncCountries(db, auth, siteId, range),
    syncDevices(db, auth, siteId, range),
  ])
}
```

## 3. drizzle-kit Migrations

Add migration tooling.

```json
// package.json scripts
{
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "db:studio": "drizzle-kit studio"
}
```

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
})
```

## 4. Query Helpers

Common query patterns for retrieving stored data.

```ts
// src/queries.ts

// Get page performance trend over time
export const getPageTrend = (db: GscDb, siteId: number, path: string, startDate: string, endDate: string) =>
  db.select()
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      eq(sitePathDateAnalytics.path, path),
      gte(sitePathDateAnalytics.date, startDate),
      lte(sitePathDateAnalytics.date, endDate),
    ))
    .orderBy(sitePathDateAnalytics.date)

// Get top pages by clicks for a date range
export const getTopPages = (db: GscDb, siteId: number, startDate: string, endDate: string, limit = 100) =>
  db.select({
    path: sitePathDateAnalytics.path,
    totalClicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`,
    totalImpressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`,
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, startDate),
      lte(sitePathDateAnalytics.date, endDate),
    ))
    .groupBy(sitePathDateAnalytics.path)
    .orderBy(desc(sql`sum(${sitePathDateAnalytics.clicks})`))
    .limit(limit)

// Get keyword rankings for a page
export const getPageKeywords = (db: GscDb, siteId: number, path: string, date: string) =>
  // requires siteKeywordDatePathAnalytics if we want path-level keyword data
  // current schema has keyword-level only, may need to add

// Get site daily totals
export const getSiteDailyTotals = (db: GscDb, siteId: number, startDate: string, endDate: string) =>
  db.select()
    .from(siteDateAnalytics)
    .where(and(
      eq(siteDateAnalytics.siteId, siteId),
      gte(siteDateAnalytics.date, startDate),
      lte(siteDateAnalytics.date, endDate),
    ))
    .orderBy(siteDateAnalytics.date)

// Compare two periods
export const comparePeriods = (db: GscDb, siteId: number, current: Period, previous: Period) => {
  // aggregate both periods and return diff
}
```

## 5. CLI Integration (Optional)

Add sync command to gscdump CLI.

```bash
gscdump sync --db ./data.db --site sc-domain:example.com --period 90d
```

## Schema Considerations

### Potential Additions

**siteKeywordPathDateAnalytics** - Keyword performance per page (most granular)
```ts
// Very large table but enables "which keywords drive traffic to this page"
export const siteKeywordPathDateAnalytics = sqliteTable('site_keyword_path_date_analytics', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  date: text('date').notNull(),
  keyword: text('keyword').notNull(),
  path: text('path').notNull(),
  ...gscMetrics,
}, t => ({
  unq: unique().on(t.siteId, t.date, t.keyword, t.path),
}))
```

### Data Retention

Consider adding cleanup functions for old data:
```ts
export function pruneOldData(db: GscDb, olderThanDays: number) {
  const cutoff = formatDateGsc(dayjs().subtract(olderThanDays, 'day'))
  // delete from all analytics tables where date < cutoff
}
```

### Incremental Sync

Track sync state to only fetch new data:
```ts
// On sites table: lastSynced timestamp
// On sync: only fetch dates > lastSynced
```

## Dependencies to Add

```yaml
# pnpm-workspace.yaml catalog
drizzle-kit: ^0.30.0
better-sqlite3: ^11.0.0
```

## File Structure

```
packages/db/
├── src/
│   ├── index.ts        # exports
│   ├── schema.ts       # drizzle schema ✓
│   ├── connector.ts    # db0 setup
│   ├── sync.ts         # sync functions
│   └── queries.ts      # query helpers
├── drizzle/            # migrations output
├── drizzle.config.ts
└── package.json
```
