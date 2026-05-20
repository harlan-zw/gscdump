/**
 * data-query — generic BuilderState-driven query.
 *
 * Plan composition lives in `../query`; the dialect adapter is supplied by
 * the source via `BuildContext` so the same analyzer compiles correctly
 * against any SQL dialect that satisfies `ResolverAdapter`.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { defineAnalyzer, requireAdapter } from '@gscdump/engine/analyzer'
import { buildDataQueryPlan, buildDataQueryRows, shapeDataQueryRowResults, shapeDataQueryRows } from '../query'

export type DataQueryResult = Row

export const dataQueryAnalyzer = defineAnalyzer<AnalysisParams, Row, DataQueryResult[]>({
  id: 'data-query',
  sqlRequires: ['executeSql', 'attachedTables', 'adapter'],

  buildSql(params, ctx) {
    const plan = buildDataQueryPlan(params, { adapter: requireAdapter(ctx, 'data-query'), siteId: ctx.siteId })
    return {
      sql: plan.sql,
      params: plan.params,
      current: { table: plan.tableKey, partitions: [] },
      extraQueries: plan.extraQueries,
    }
  },

  reduceSql(rows, params, ctx) {
    const arr = Array.isArray(rows) ? rows : []
    const { results, meta } = shapeDataQueryRows(arr, params, ctx.extras)
    return { results: results as DataQueryResult[], meta }
  },

  // Row path — the cross-dimension fallback. No `adapter` needed: each plan
  // entry is a plain BuilderState run through the source's `queryRows`, which
  // the composite source routes to live GSC.
  buildRows(params) {
    return buildDataQueryRows(params)
  },

  reduceRows(rows, params) {
    const rowMap = (Array.isArray(rows) ? {} : rows) as Record<string, Row[]>
    const { results, meta } = shapeDataQueryRowResults(rowMap, params)
    return { results: results as DataQueryResult[], meta }
  },
})
