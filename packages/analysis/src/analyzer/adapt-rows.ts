/**
 * Adapter: builds a row-based `Analyzer` from a query-composition function
 * and a pure reducer. Each row-based tool has one entry in the registry.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { BuilderState } from 'gscdump/query'
import type { AnalysisPeriod } from '../period'
import type { AnalysisParams } from '../types'
import type { Analyzer, Capability, Plan, ReduceContext, RowQueriesPlan } from './types'

import { between, date as dateCol, gsc, page as pageCol, query as queryCol } from 'gscdump/query'

const DEFAULT_LIMIT = 25_000

// Canonical BuilderState factories for the three row shapes the portable
// dispatcher used. Shared here so every row-based analyzer composes its
// requirements from the same primitives.

export function keywordsQueryState(period: AnalysisPeriod, limit: number = DEFAULT_LIMIT): BuilderState {
  return gsc.select(queryCol, pageCol).where(between(dateCol, period.startDate, period.endDate)).limit(limit).getState()
}

export function pagesQueryState(period: AnalysisPeriod, limit: number = DEFAULT_LIMIT): BuilderState {
  return gsc.select(pageCol).where(between(dateCol, period.startDate, period.endDate)).limit(limit).getState()
}

export function datesQueryState(period: AnalysisPeriod, limit: number = DEFAULT_LIMIT): BuilderState {
  return gsc.select(dateCol).where(between(dateCol, period.startDate, period.endDate)).limit(limit).getState()
}

export interface AdaptRowsOptions<R> {
  id: string
  requires?: readonly Capability[]
  buildQueries: (params: AnalysisParams) => Record<string, BuilderState>
  reduce: (rows: Record<string, Row[]>, params: AnalysisParams) => { results: R, meta?: Record<string, unknown> }
}

/**
 * Wrap a row-based analyzer into the unified contract. The analyzer's plan
 * is a `RowQueriesPlan` keyed by query name; the reducer receives the row
 * map and returns typed results.
 */
export function adaptRowAnalyzer<R>(opts: AdaptRowsOptions<R>): Analyzer {
  const { id, requires = [], buildQueries, reduce } = opts
  return {
    id,
    requires,
    build(params: AnalysisParams): Plan {
      const queries = buildQueries(params)
      const plan: RowQueriesPlan = {
        kind: 'rows',
        queries: Object.fromEntries(
          Object.entries(queries).map(([k, state]) => [k, { state }]),
        ),
      }
      return plan
    },
    reduce(rows: Row[] | Record<string, Row[]>, ctx: ReduceContext) {
      const map = Array.isArray(rows) ? { primary: rows } : rows
      const { results, meta } = reduce(map as Record<string, Row[]>, ctx.params)
      return { results, meta }
    },
  }
}
