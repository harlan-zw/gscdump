/**
 * Adapter: wraps a legacy `duckdb/analyzers/*` builder (`(params) → AnalyzerSpec`)
 * into the unified `Analyzer` contract.
 *
 * `build` projects the spec into a `SqlPlan`. `reduce` re-runs the builder to
 * recover the `shape` closure — safe because builders are pure and cheap.
 */

import type { Analyzer, Capability, Plan, ReduceContext, SqlPlan } from '@gscdump/analysis/analyzer'
import type { AnalysisParams, AnalyzerSpec, Row } from './shared'

export type SqlBuilder = (params: AnalysisParams) => AnalyzerSpec

export interface AdaptSqlOptions {
  id: string
  builder: SqlBuilder
  requires?: readonly Capability[]
}

const DEFAULT_SQL_REQUIRES: readonly Capability[] = ['executeSql', 'partitionedParquet']

export function adaptSqlAnalyzer(opts: AdaptSqlOptions): Analyzer {
  const { id, builder, requires = DEFAULT_SQL_REQUIRES } = opts
  return {
    id,
    requires,
    build(params: AnalysisParams): Plan {
      const spec = builder(params)
      const plan: SqlPlan = {
        kind: 'sql',
        sql: spec.sql,
        params: spec.params,
        current: spec.current,
        previous: spec.previous,
        extraFiles: spec.extraFiles,
        extraQueries: spec.extraQueries,
        requiresAttachedTables: spec.requiresAttachedTables,
      }
      return plan
    },
    reduce(rows: Row[] | Record<string, Row[]>, ctx: ReduceContext) {
      const spec = builder(ctx.params)
      const rowArr = Array.isArray(rows) ? rows : Object.values(rows)[0] ?? []
      const shaped = spec.shape(rowArr, ctx.params, ctx.extras)
      return { results: shaped.results, meta: shaped.meta }
    },
  }
}
