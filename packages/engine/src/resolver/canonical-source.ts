// Eligibility gate for the canonical-grained fact aggregate (ADR-0018 Gap 2).
// The `query_canonical_daily` rollup carries only (query_canonical, date,
// metrics), so it can answer a query ONLY when that query groups solely by
// canonical (optionally over date) and never references a column the rollup
// dropped (raw query, page, country, …) or the raw per-row grain (metric
// prefilters, top-level page filter). Metrics are additive, so SUM/HAVING and
// metric ordering over the pre-summed rows are exact.

import type { BuilderState } from 'gscdump/query'
import type { LogicalQueryPlan, PlannerCapabilities } from 'gscdump/query/plan'
import { buildLogicalPlan } from 'gscdump/query/plan'

const ALLOWED_FILTER_DIMS = new Set(['date', 'queryCanonical'])

/**
 * True when `plan` can be served from the canonical-grained rollup instead of
 * the raw `queries` fact partitions. Conservative: anything that would read a
 * dropped column or the raw row grain disqualifies the query, so a false
 * negative just falls back to live aggregation (correct, slower) — never wrong
 * data.
 */
export function planCoveredByCanonicalRollup(plan: LogicalQueryPlan): boolean {
  // Rollup is built from the `queries` table only.
  if (plan.dataset !== 'queries')
    return false
  // Group by exactly `queryCanonical` (date is tracked via `hasDate`, excluded
  // from `groupByDimensions`). Grouping by raw `query` or anything else is out.
  if (plan.groupByDimensions.length !== 1 || plan.groupByDimensions[0] !== 'queryCanonical')
    return false
  // Filters may reference only date / queryCanonical — both present in the
  // rollup. A raw `query` filter needs the dropped `query` column.
  if (!plan.dimensionFilters.every(f => ALLOWED_FILTER_DIMS.has(f.dimension)))
    return false
  // Per-row metric prefilters and the top-level page filter operate on the raw
  // (query × date) grain, which the pre-summed rollup no longer has.
  if (plan.prefilters.length > 0)
    return false
  if (plan.specialFilters.topLevel)
    return false
  return true
}

/** State-level convenience: build the plan then gate. */
export function canonicalRollupCovers(state: BuilderState, capabilities: PlannerCapabilities): boolean {
  return planCoveredByCanonicalRollup(buildLogicalPlan(state, capabilities))
}
