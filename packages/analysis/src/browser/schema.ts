/**
 * Drizzle table definitions for the GSC analytics schema.
 *
 * Kept in lockstep with gscdump/analytics/SCHEMAS: if that const gains a
 * column, mirror it here. A runtime check at the bottom asserts the two
 * stay in sync so drift fails loudly in tests.
 */

import { date, doublePrecision, integer, pgTable, varchar } from 'drizzle-orm/pg-core'
import { SCHEMAS } from 'gscdump/analytics/schema'

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

export const schema = { pages, keywords, countries, devices, page_keywords }
export type Schema = typeof schema

function assertInSync(): void {
  for (const [name, table] of Object.entries(schema)) {
    const sourceCols = SCHEMAS[name as keyof typeof SCHEMAS].columns.map(c => c.name).sort()
    const drizzleCols = Object.keys((table as any)[Symbol.for('drizzle:Columns')] ?? {}).sort()
    const missing = sourceCols.filter(c => !drizzleCols.includes(c))
    const extra = drizzleCols.filter(c => !sourceCols.includes(c))
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Drizzle schema for '${name}' drifted from SCHEMAS. Missing: [${missing.join(', ')}]. Extra: [${extra.join(', ')}].`,
      )
    }
  }
}

assertInSync()
