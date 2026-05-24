/**
 * Canonical drizzle pg-core schema — single source of truth for the GSC
 * analytics storage shape. Consumed directly by engine-duckdb-wasm / DuckDB-WASM
 * (runs Postgres-flavored SQL natively) and by the node DuckDB adapter.
 * The engine-sqlite schema declares its own sqlite-core tables, but its
 * column set must be a superset of these (enforced by `assertSchemaInSync`
 * in that package).
 *
 * Abstract `SCHEMAS: Record<TableName, TableSchema>` in `./schema` is
 * derived from this file via drizzle `getTableConfig`; parquet writer /
 * planner / hyparquet codec consume the derived shape. Adding a column =
 * edit one drizzle table; everything downstream updates.
 *
 * `TABLE_METADATA` carries sortKey + clusterKey + schema version that drizzle
 * can't express; bump `version` when a table's physical layout changes so
 * stored manifests tag rows correctly.
 *
 * `sortKey` is the natural-key identity (used by `dedupeByNaturalKey` and the
 * manifest dedup `PARTITION BY`) — order is irrelevant, only membership.
 * `clusterKey` is the physical row order written into parquet: dimension-first
 * (`query`/`url` before `date`) so the high-cardinality dimension column is
 * contiguous within each row group. That keeps dictionary indices run-length
 * friendly (smaller files) and tightens per-dimension page statistics (so a
 * per-entity query — the keyword/page sparkline + detail charts — prunes pages
 * sharply). Raw daily files carry a single `date`, so this only changes the
 * physical layout of multi-day compacted tiers (d7/d30/d90).
 */

import type { TableName } from '@gscdump/contracts'

import { date, doublePrecision, integer, pgTable, varchar } from 'drizzle-orm/pg-core'

function metricCols(): {
  clicks: ReturnType<ReturnType<typeof integer>['notNull']>
  impressions: ReturnType<ReturnType<typeof integer>['notNull']>
  sum_position: ReturnType<ReturnType<typeof doublePrecision>['notNull']>
} {
  return {
    clicks: integer('clicks').notNull(),
    impressions: integer('impressions').notNull(),
    sum_position: doublePrecision('sum_position').notNull(),
  }
}

const dateCol = (): ReturnType<ReturnType<typeof date>['notNull']> => date('date').notNull()

export const pages = pgTable('pages', {
  url: varchar('url').notNull(),
  date: dateCol(),
  ...metricCols(),
})

export const queries = pgTable('queries', {
  query: varchar('query').notNull(),
  query_canonical: varchar('query_canonical'),
  date: dateCol(),
  ...metricCols(),
})

export const countries = pgTable('countries', {
  country: varchar('country').notNull(),
  date: dateCol(),
  ...metricCols(),
})

export const page_queries = pgTable('page_queries', {
  url: varchar('url').notNull(),
  query: varchar('query').notNull(),
  query_canonical: varchar('query_canonical'),
  date: dateCol(),
  ...metricCols(),
})

/**
 * Per-`(site, search_type, date)` daily totals + device breakdown.
 *
 * Replaces the standalone `devices` long table and the legacy `daily_totals`
 * rollup. Does NOT fit the generic `metricCols()` shape — it has bespoke
 * site-total columns, an anonymized-impressions ratio, and a 9-column device
 * pivot (clicks/impressions/sum_position × desktop/mobile/tablet).
 *
 * - `clicks`/`impressions`/`sum_position`: TRUE site totals from a GSC
 *   `['date']` query — authoritative, includes anonymized impressions.
 * - `anonymized_impressions_pct`: `1 - query_grained_impressions /
 *   page_grained_impressions` — fraction of impressions GSC withholds at
 *   query grain. Mirrors the legacy `dailyTotalsRollup` formula.
 * - `clicks_{device}` / `impressions_{device}` / `sum_position_{device}`:
 *   device breakdown pivoted from a GSC `['date','device']` query.
 */
export const dates = pgTable('dates', {
  date: dateCol(),
  clicks: integer('clicks').notNull(),
  impressions: integer('impressions').notNull(),
  sum_position: doublePrecision('sum_position').notNull(),
  anonymized_impressions_pct: doublePrecision('anonymized_impressions_pct').notNull(),
  clicks_desktop: integer('clicks_desktop').notNull(),
  clicks_mobile: integer('clicks_mobile').notNull(),
  clicks_tablet: integer('clicks_tablet').notNull(),
  impressions_desktop: integer('impressions_desktop').notNull(),
  impressions_mobile: integer('impressions_mobile').notNull(),
  impressions_tablet: integer('impressions_tablet').notNull(),
  sum_position_desktop: doublePrecision('sum_position_desktop').notNull(),
  sum_position_mobile: doublePrecision('sum_position_mobile').notNull(),
  sum_position_tablet: doublePrecision('sum_position_tablet').notNull(),
})

export const search_appearance = pgTable('search_appearance', {
  searchAppearance: varchar('searchAppearance').notNull(),
  date: dateCol(),
  ...metricCols(),
})

export const search_appearance_pages = pgTable('search_appearance_pages', {
  searchAppearance: varchar('searchAppearance').notNull(),
  url: varchar('url').notNull(),
  date: dateCol(),
  ...metricCols(),
})

export const search_appearance_queries = pgTable('search_appearance_queries', {
  searchAppearance: varchar('searchAppearance').notNull(),
  query: varchar('query').notNull(),
  query_canonical: varchar('query_canonical'),
  date: dateCol(),
  ...metricCols(),
})

export const search_appearance_page_queries = pgTable('search_appearance_page_queries', {
  searchAppearance: varchar('searchAppearance').notNull(),
  url: varchar('url').notNull(),
  query: varchar('query').notNull(),
  query_canonical: varchar('query_canonical'),
  date: dateCol(),
  ...metricCols(),
})

// Per-(url, hour) Discover slice. `hour` is the GSC `hourly_all` timestamp
// (ISO 8601 with PT offset, e.g. `2026-05-17T15:00:00-07:00`). `date` is the
// derived PT calendar day used for partitioning; one parquet file per day
// holds 24 hourly buckets per url. Read-merge-write keyed on (url, hour).
export const hourly_pages = pgTable('hourly_pages', {
  url: varchar('url').notNull(),
  hour: varchar('hour').notNull(),
  date: dateCol(),
  ...metricCols(),
})

export const drizzleSchema = { pages, queries, countries, page_queries, dates, search_appearance, search_appearance_pages, search_appearance_queries, search_appearance_page_queries, hourly_pages }
export type DrizzleSchema = typeof drizzleSchema

export const TABLE_METADATA: Record<TableName, { sortKey: string[], clusterKey: string[], version: number }> = {
  pages: { sortKey: ['date', 'url'], clusterKey: ['url', 'date'], version: 1 },
  queries: { sortKey: ['date', 'query'], clusterKey: ['query', 'date'], version: 2 },
  countries: { sortKey: ['date', 'country'], clusterKey: ['country', 'date'], version: 1 },
  page_queries: { sortKey: ['date', 'url', 'query'], clusterKey: ['url', 'query', 'date'], version: 2 },
  dates: { sortKey: ['date'], clusterKey: ['date'], version: 1 },
  search_appearance: { sortKey: ['date', 'searchAppearance'], clusterKey: ['searchAppearance', 'date'], version: 1 },
  search_appearance_pages: { sortKey: ['date', 'searchAppearance', 'url'], clusterKey: ['searchAppearance', 'url', 'date'], version: 1 },
  search_appearance_queries: { sortKey: ['date', 'searchAppearance', 'query'], clusterKey: ['searchAppearance', 'query', 'date'], version: 1 },
  search_appearance_page_queries: { sortKey: ['date', 'searchAppearance', 'url', 'query'], clusterKey: ['searchAppearance', 'url', 'query', 'date'], version: 1 },
  hourly_pages: { sortKey: ['date', 'hour', 'url'], clusterKey: ['url', 'date', 'hour'], version: 1 },
}
