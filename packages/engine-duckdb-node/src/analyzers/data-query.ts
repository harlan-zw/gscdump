/**
 * data-query — generic BuilderState-driven query.
 *
 * Query planning + shaping live in `@gscdump/analysis/query`; this adapter
 * just wires the runtime-neutral plan into a browser-only AnalyzerSpec with
 * direct table refs (`"pages"`, `"keywords"`, ...) resolved against the
 * attached schema.
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'
import { buildDataQueryPlan } from '@gscdump/analysis/query'
import { pgResolverAdapter } from '@gscdump/engine/resolver'

export function buildDataQuery(params: AnalysisParams): AnalyzerSpec {
  const plan = buildDataQueryPlan(params, { adapter: pgResolverAdapter })
  return {
    sql: plan.sql,
    params: plan.params,
    current: { table: plan.tableKey, partitions: [] },
    requiresAttachedTables: true,
    extraQueries: plan.extraQueries,
    shape: plan.shape,
  }
}
