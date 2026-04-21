/**
 * Typed SQL fragments for GSC metric aggregations.
 *
 * Replaces `METRICS_SQL` string constants: every analysis route recomputes
 * clicks/impressions/ctr/position the same way, so centralize. All take a
 * gsc_* table handle and emit a drizzle `sql` expression with typed column
 * refs — misspell a column name and tsc catches it.
 *
 * `positionExpr` adds +1 to match GSC's 1-indexed position (stored as
 * `sum_position = (position - 1) * impressions` at ingest).
 */

import type { SQL } from 'drizzle-orm'

import type {
  gsc_countries,
  gsc_devices,
  gsc_keywords,
  gsc_page_keywords,
  gsc_pages,
} from './schema'

import { sql } from 'drizzle-orm'

type MetricTable
  = | typeof gsc_pages
    | typeof gsc_keywords
    | typeof gsc_countries
    | typeof gsc_devices
    | typeof gsc_page_keywords

export function aggClicks(t: MetricTable): SQL {
  return sql`SUM(${t.clicks})`
}

export function aggImpressions(t: MetricTable): SQL {
  return sql`SUM(${t.impressions})`
}

export function aggCtr(t: MetricTable): SQL {
  return sql`CAST(SUM(${t.clicks}) AS REAL) / NULLIF(SUM(${t.impressions}), 0)`
}

export function aggPosition(t: MetricTable): SQL {
  return sql`SUM(${t.sum_position}) / NULLIF(SUM(${t.impressions}), 0) + 1`
}
