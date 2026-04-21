/**
 * Shared SQL fragments + escapers consumed by both the engine compiler
 * (`gscdump/analytics/compiler.ts`) and the analysis runtime-builder
 * (`@gscdump/analysis/core/runtime-builder.ts`).
 *
 * Why two compilers exist at all: the engine emits raw SQL strings + `?`
 * placeholders for DuckDB over R2 / filesystem; the analysis runtime-builder
 * emits drizzle `SQL` templates for browser / sqlite / D1. Same intent
 * (dimension predicates, metric aggregates, HAVING clauses), different
 * output surfaces. The branch dispatch is duplicated by design — sharing
 * the constants (the bits that are pure strings) without forcing drizzle
 * into gscdump core or a leaky predicate AST into both paths.
 */

import type { Metric } from './types'

/**
 * Standard SQL `LIKE` escape. Backslash is the explicit ESCAPE char so
 * literal `%`, `_`, and `\` survive a `contains` predicate unchanged.
 */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Per-metric raw SQL aggregate expression. Used by the engine compiler;
 * the drizzle runtime-builder produces structurally equivalent SQL but
 * via column refs from the attached schema.
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
 * Top-level page predicate: matches paths with at most one `/`. Reused
 * by both compilers; expressed as a SQL fragment template parameterized
 * on the resolved column expression.
 */
export function topLevelPagePredicateSql(pathExpr: string): string {
  return `LENGTH(${pathExpr}) - LENGTH(REPLACE(${pathExpr}, '/', '')) <= 1`
}
