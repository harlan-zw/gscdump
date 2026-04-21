/**
 * data-detail — generic BuilderState-driven detail (date-grouped) query.
 *
 * Query planning + shaping live in `@gscdump/analysis/query`; this adapter
 * just wires the runtime-neutral plan into a browser-only AnalyzerSpec with
 * direct table refs (`"pages"`, `"keywords"`, ...) resolved against the
 * attached schema.
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'
import { buildDataDetailPlan } from '@gscdump/analysis/query'
import { pgResolverAdapter } from '@gscdump/engine/resolver'

export function buildDataDetail(params: AnalysisParams): AnalyzerSpec {
  const plan = buildDataDetailPlan(params, { adapter: pgResolverAdapter })
  return {
    sql: plan.sql,
    params: plan.params,
    current: { table: plan.tableKey, partitions: [] },
    requiresAttachedTables: true,
    extraQueries: plan.extraQueries,
    shape: plan.shape,
  }
}
