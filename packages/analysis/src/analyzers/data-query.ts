/**
 * data-query — generic BuilderState-driven query.
 *
 * Query planning + shaping live in `../query`; this analyzer thinly wraps
 * the runtime-neutral plan into a SQL plan with direct table refs
 * (`"pages"`, `"keywords"`, ...) resolved against the attached schema.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { pgResolverAdapter } from '@gscdump/engine/resolver'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { buildDataQueryPlan } from '../query'

export type DataQueryResult = Row

export const dataQueryAnalyzer = defineAnalyzer<AnalysisParams, Row, DataQueryResult[]>({
  id: 'data-query',

  buildSql(params) {
    const plan = buildDataQueryPlan(params, { adapter: pgResolverAdapter })
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
    const plan = buildDataQueryPlan(params, { adapter: pgResolverAdapter })
    const { results, meta } = plan.shape(arr, params, ctx.extras)
    return { results: results as DataQueryResult[], meta }
  },
})
