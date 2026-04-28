/**
 * data-detail — generic BuilderState-driven detail (date-grouped) query.
 *
 * Query planning + shaping live in `../query`; this analyzer thinly wraps
 * the runtime-neutral plan into a SQL plan with direct table refs
 * (`"pages"`, `"keywords"`, ...) resolved against the attached schema.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { pgResolverAdapter } from '@gscdump/engine/resolver'
import { buildDataDetailPlan } from '../query'

export type DataDetailResult = Row

export const dataDetailAnalyzer = defineAnalyzer<AnalysisParams, Row, DataDetailResult[]>({
  id: 'data-detail',

  buildSql(params) {
    const plan = buildDataDetailPlan(params, { adapter: pgResolverAdapter })
    return {
      sql: plan.sql,
      params: plan.params,
      current: { table: plan.tableKey, partitions: [] },
      requiresAttachedTables: true,
      extraQueries: plan.extraQueries,
    }
  },

  reduceSql(rows, params, ctx) {
    const arr = Array.isArray(rows) ? rows : []
    const plan = buildDataDetailPlan(params, { adapter: pgResolverAdapter })
    const { results, meta } = plan.shape(arr, params, ctx.extras)
    return { results: results as DataDetailResult[], meta }
  },
})
