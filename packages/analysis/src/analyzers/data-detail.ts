/**
 * data-detail — generic BuilderState-driven detail (date-grouped) query.
 *
 * Plan composition lives in `../query`; the dialect adapter is supplied by
 * the source via `BuildContext` so the same analyzer compiles correctly
 * against any SQL dialect that satisfies `ResolverAdapter`.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { defineAnalyzer, requireAdapter } from '@gscdump/engine/analyzer'
import { buildDataDetailPlan, buildDataDetailRows, shapeDataDetailRowResults, shapeDataDetailRows } from '../query'

export type DataDetailResult = Row

export const dataDetailAnalyzer = defineAnalyzer<AnalysisParams, Row, DataDetailResult[]>({
  id: 'data-detail',
  sqlRequires: ['executeSql', 'attachedTables', 'adapter'],

  buildSql(params, ctx) {
    const plan = buildDataDetailPlan(params, { adapter: requireAdapter(ctx, 'data-detail'), siteId: ctx.siteId })
    return {
      sql: plan.sql,
      params: plan.params,
      current: { table: plan.tableKey, partitions: [] },
      extraQueries: plan.extraQueries,
    }
  },

  reduceSql(rows, params, ctx) {
    const arr = Array.isArray(rows) ? rows : []
    const { results, meta } = shapeDataDetailRows(arr, params, ctx.extras)
    return { results: results as DataDetailResult[], meta }
  },

  // Row path — the cross-dimension fallback (see data-query.ts).
  buildRows(params) {
    return buildDataDetailRows(params)
  },

  reduceRows(rows, params) {
    const rowMap = (Array.isArray(rows) ? {} : rows) as Record<string, Row[]>
    const { results, meta } = shapeDataDetailRowResults(rowMap, params)
    return { results: results as DataDetailResult[], meta }
  },
})
