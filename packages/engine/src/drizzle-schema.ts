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
 * `TABLE_METADATA` carries sortKey + schema version that drizzle can't
 * express; bump `version` when a table's physical layout changes so stored
 * manifests tag rows correctly.
 */

import type { TableName } from 'gscdump/contracts'

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

export const keywords = pgTable('keywords', {
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

export const devices = pgTable('devices', {
  device: varchar('device').notNull(),
  date: dateCol(),
  ...metricCols(),
})

export const page_keywords = pgTable('page_keywords', {
  url: varchar('url').notNull(),
  query: varchar('query').notNull(),
  query_canonical: varchar('query_canonical'),
  date: dateCol(),
  ...metricCols(),
})

export const search_appearance = pgTable('search_appearance', {
  searchAppearance: varchar('searchAppearance').notNull(),
  date: dateCol(),
  ...metricCols(),
})

export const drizzleSchema = { pages, keywords, countries, devices, page_keywords, search_appearance }
export type DrizzleSchema = typeof drizzleSchema

export const TABLE_METADATA: Record<TableName, { sortKey: string[], version: number }> = {
  pages: { sortKey: ['date', 'url'], version: 1 },
  keywords: { sortKey: ['date', 'query'], version: 2 },
  countries: { sortKey: ['date', 'country'], version: 1 },
  devices: { sortKey: ['date', 'device'], version: 1 },
  page_keywords: { sortKey: ['date', 'url', 'query'], version: 2 },
  search_appearance: { sortKey: ['date', 'searchAppearance'], version: 1 },
}
