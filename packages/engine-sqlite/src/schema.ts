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

import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
})

export const gsc_keywords = sqliteTable('gsc_keywords', {
  ...baseCols(),
  query: text('query').notNull(),
  query_canonical: text('query_canonical'),
  ...metricCols(),
})

export const gsc_countries = sqliteTable('gsc_countries', {
  ...baseCols(),
  country: text('country').notNull(),
  ...metricCols(),
})

export const gsc_devices = sqliteTable('gsc_devices', {
  ...baseCols(),
  device: text('device').notNull(),
  ...metricCols(),
})

export const gsc_page_keywords = sqliteTable('gsc_page_keywords', {
  ...baseCols(),
  url: text('url').notNull(),
  query: text('query').notNull(),
  query_canonical: text('query_canonical'),
  ...metricCols(),
})

export const schema = {
  gsc_pages,
  gsc_keywords,
  gsc_countries,
  gsc_devices,
  gsc_page_keywords,
}

export type Schema = typeof schema

const GSC_PREFIX_RE = /^gsc_/
assertSchemaInSync({
  label: 'sqlite',
  schema,
  tableKeyToName: key => key.replace(GSC_PREFIX_RE, '') as TableName,
  mode: 'superset',
})
