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

/**
 * How a canonicalized date column is emitted by {@link dateReplaceClause}:
 * - `'date'` keeps a real `DATE` value (`CAST(col AS DATE)`). Right for views
 *   and `.duckdb` exports the app re-queries, where the column type matters.
 * - `'string'` emits an ISO `YYYY-MM-DD` string (`strftime(CAST(col AS DATE)…)`).
 *   Right for row materialisation to JSON/CSV/NDJSON, where a `DATE` would
 *   serialize as an opaque object / epoch.
 */
export type DateCanonicalForm = 'date' | 'string'

/**
 * Build a `read_parquet` `REPLACE (…)` clause that canonicalizes legacy `date`
 * columns. `date` lands as VARCHAR in older parquets (BYTE_ARRAY/UTF8, written
 * before the schema enforced DATE); DuckDB infers the column type from the file,
 * so without this every read path would expose VARCHAR despite SCHEMAS declaring
 * DATE. The `CAST(col AS DATE)` is a no-op for already-DATE columns and
 * vectorized parsing for VARCHAR ones, so output stays canonical either way.
 *
 * Pure: the caller passes the table's DATE column names (derived from `SCHEMAS`)
 * so this fragment carries no schema/drizzle dependency. Returns `''` when the
 * table has no DATE columns, so callers can interpolate it unconditionally:
 *   `SELECT * ${dateReplaceClause(cols)} FROM read_parquet(…)`.
 */
export function dateReplaceClause(
  dateColumns: readonly string[],
  form: DateCanonicalForm = 'string',
): string {
  if (dateColumns.length === 0)
    return ''
  const cast = (n: string): string => form === 'date'
    ? `CAST(${n} AS DATE) AS ${n}`
    : `strftime(CAST(${n} AS DATE), '%Y-%m-%d') AS ${n}`
  return `REPLACE (${dateColumns.map(cast).join(', ')})`
}
