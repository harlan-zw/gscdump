/**
 * Drizzle sqlite-core table definitions for the GSC analytics schema on D1.
 *
 * These match the per-user D1 tables (`gsc_pages`, `gsc_keywords`, etc.) —
 * flat, `site_id`-scoped, `sum_position` stored so metrics recompute under
 * aggregation. Mirror of gscdump.com/database/user/schema.ts relative to
 * the columns analytics queries actually read.
 */

import type { TableName } from '@gscdump/engine/contracts'
import { assertSchemaInSync } from '@gscdump/engine/resolver'
import { sql } from 'drizzle-orm'

import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

function metricCols(): {
  clicks: ReturnType<ReturnType<ReturnType<typeof integer>['notNull']>['default']>
  impressions: ReturnType<ReturnType<ReturnType<typeof integer>['notNull']>['default']>
  ctr: ReturnType<ReturnType<ReturnType<typeof real>['notNull']>['default']>
  position: ReturnType<ReturnType<ReturnType<typeof real>['notNull']>['default']>
  sum_position: ReturnType<ReturnType<ReturnType<typeof real>['notNull']>['default']>
} {
  return {
    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    ctr: real('ctr').notNull().default(0),
    position: real('position').notNull().default(0),
    sum_position: real('sum_position').notNull().default(0),
  }
}

function baseCols(): {
  id: ReturnType<ReturnType<typeof text>['primaryKey']>
  site_id: ReturnType<ReturnType<typeof text>['notNull']>
  date: ReturnType<ReturnType<typeof text>['notNull']>
  created_at: ReturnType<ReturnType<typeof integer>['default']>
} {
  return {
    id: text('id').primaryKey(),
    site_id: text('site_id').notNull(),
    date: text('date').notNull(),
    created_at: integer('created_at').default(sql`(unixepoch())`),
  }
}

export const gsc_pages = sqliteTable('gsc_pages', {
  ...baseCols(),
  url: text('url').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_pages_site_date').on(t.site_id, t.date),
])

export const gsc_keywords = sqliteTable('gsc_keywords', {
  ...baseCols(),
  query: text('query').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_keywords_site_date').on(t.site_id, t.date),
])

export const gsc_countries = sqliteTable('gsc_countries', {
  ...baseCols(),
  country: text('country').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_countries_site_date').on(t.site_id, t.date),
])

export const gsc_devices = sqliteTable('gsc_devices', {
  ...baseCols(),
  device: text('device').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_devices_site_date').on(t.site_id, t.date),
])

export const gsc_page_keywords = sqliteTable('gsc_page_keywords', {
  ...baseCols(),
  url: text('url').notNull(),
  query: text('query').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_page_keywords_site_date').on(t.site_id, t.date),
])

export const gsc_search_appearance = sqliteTable('gsc_search_appearance', {
  ...baseCols(),
  searchAppearance: text('searchAppearance').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_search_appearance_site_date').on(t.site_id, t.date),
])

export const gsc_search_appearance_pages = sqliteTable('gsc_search_appearance_pages', {
  ...baseCols(),
  searchAppearance: text('searchAppearance').notNull(),
  url: text('url').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_search_appearance_pages_site_date').on(t.site_id, t.date),
])

export const gsc_search_appearance_queries = sqliteTable('gsc_search_appearance_queries', {
  ...baseCols(),
  searchAppearance: text('searchAppearance').notNull(),
  query: text('query').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_search_appearance_queries_site_date').on(t.site_id, t.date),
])

export const gsc_search_appearance_page_queries = sqliteTable('gsc_search_appearance_page_queries', {
  ...baseCols(),
  searchAppearance: text('searchAppearance').notNull(),
  url: text('url').notNull(),
  query: text('query').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_search_appearance_page_queries_site_date').on(t.site_id, t.date),
])

export const gsc_query_dim = sqliteTable('gsc_query_dim', {
  site_id: text('site_id').notNull(),
  query: text('query').notNull(),
  query_canonical: text('query_canonical').notNull(),
  normalizer_version: integer('normalizer_version').notNull(),
  intent_code: integer('intent_code'),
  intent_version: integer('intent_version'),
  built_at: integer('built_at'),
}, t => [
  index('idx_gsc_query_dim_site_query').on(t.site_id, t.query),
])

export const gsc_hourly_pages = sqliteTable('gsc_hourly_pages', {
  ...baseCols(),
  url: text('url').notNull(),
  // PT hour-of-day (0-23) — mirrors the canonical INTEGER `hour` in @gscdump/engine.
  hour: integer('hour').notNull(),
  ...metricCols(),
}, t => [
  index('idx_gsc_hourly_pages_site_date').on(t.site_id, t.date),
])

export const schema = {
  gsc_pages,
  gsc_keywords,
  gsc_countries,
  gsc_devices,
  gsc_page_keywords,
  gsc_search_appearance,
  gsc_search_appearance_pages,
  gsc_search_appearance_queries,
  gsc_search_appearance_page_queries,
  gsc_hourly_pages,
  gsc_query_dim,
}

export type Schema = typeof schema

/**
 * Physical per-user D1 table → logical engine `TableName`.
 *
 * DECISION (Iceberg re-architecture): the physical D1 table names stay
 * `gsc_keywords` / `gsc_page_keywords` / `gsc_devices` — renaming them needs a
 * forbidden destructive D1 migration, and the user-DB tables are being
 * replaced wholesale by Iceberg. Only the *logical* name they map to is
 * renamed (`queries`, `page_queries`).
 *
 * `gsc_devices` has NO logical counterpart: the standalone `devices` table was
 * retired and folded into the pivoted `dates` table, which the row-grained
 * D1 `gsc_devices` table cannot satisfy. It is therefore excluded from the
 * schema-drift assertion and the resolver dataset map — device-grained reads
 * route to the live GSC API on the legacy D1 path.
 */
const GSC_TABLE_TO_LOGICAL: Record<keyof typeof schema, TableName | null> = {
  gsc_pages: 'pages',
  gsc_keywords: 'queries',
  gsc_countries: 'countries',
  gsc_devices: null,
  gsc_page_keywords: 'page_queries',
  gsc_search_appearance: 'search_appearance',
  gsc_search_appearance_pages: 'search_appearance_pages',
  gsc_search_appearance_queries: 'search_appearance_queries',
  gsc_search_appearance_page_queries: 'search_appearance_page_queries',
  gsc_hourly_pages: 'hourly_pages',
  gsc_query_dim: null,
}

const driftSchema = Object.fromEntries(
  Object.entries(schema).filter(([k]) => GSC_TABLE_TO_LOGICAL[k as keyof typeof schema] !== null),
)
assertSchemaInSync({
  label: 'sqlite',
  schema: driftSchema,
  tableKeyToName: key => GSC_TABLE_TO_LOGICAL[key as keyof typeof schema] as TableName,
  mode: 'superset',
})
