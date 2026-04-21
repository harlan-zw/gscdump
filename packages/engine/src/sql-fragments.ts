/**
 * SQL fragments shared across SQL consumers of the storage engine: the
 * engine compiler (raw strings for DuckDB over R2 / filesystem) and the
 * analysis runtime-builder (drizzle templates for browser / sqlite / D1).
 * Constants live here because they're pure SQL; the drizzle layer wraps
 * them rather than redefining them.
 */

import type { Metric } from 'gscdump/query'

/**
 * Standard SQL `LIKE` escape. Backslash is the explicit ESCAPE char so
 * literal `%`, `_`, and `\` survive a `contains` predicate unchanged.
 */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Per-metric raw SQL aggregate expression.
 *
 * - `clicks` / `impressions` cast to DOUBLE so DuckDB SUM doesn't return
 *   BIGINT (which loses through JSON / Workers RPC).
 * - `position` reverses the ingestion offset (`sum_position = position - 1`
 *   summed; divide by impressions and add 1 back).
 */
export const METRIC_EXPR: Record<Metric, string> = {
  clicks: 'CAST(SUM(clicks) AS DOUBLE)',
  impressions: 'CAST(SUM(impressions) AS DOUBLE)',
  ctr: 'CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0)',
  position: 'SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1',
}

/**
 * Top-level page predicate: matches paths with at most one `/`. Parameterized
 * on the resolved column expression so drizzle can pass a column ref.
 */
export function topLevelPagePredicateSql(pathExpr: string): string {
  return `LENGTH(${pathExpr}) - LENGTH(REPLACE(${pathExpr}, '/', '')) <= 1`
}
