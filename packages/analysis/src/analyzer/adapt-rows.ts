/**
 * Canonical `BuilderState` factories for the three row shapes the portable
 * dispatcher uses: keywords (`query + page`), pages (`page`), dates (`date`).
 * Shared so every row-based analyzer composes its requirements from the same
 * primitives.
 *
 * Each factory takes a `FetchBudget`, never an output `limit`. The brand
 * makes `queriesQueryState(period, params.limit)` a type error: an output cap
 * used as a fetch cap silently drops matching rows before the reducer runs.
 */

import type { FetchBudget } from '@gscdump/engine/analysis-types'
import type { AnalysisPeriod } from '@gscdump/engine/period'
import type { BuilderState } from 'gscdump/query'

import { between, date as dateCol, gsc, page as pageCol, query as queryCol } from 'gscdump/query'

export function queriesQueryState(period: AnalysisPeriod, budget: FetchBudget): BuilderState {
  return gsc.select(queryCol, pageCol).where(between(dateCol, period.startDate, period.endDate)).limit(budget).getState()
}

export function pagesQueryState(period: AnalysisPeriod, budget: FetchBudget): BuilderState {
  return gsc.select(pageCol).where(between(dateCol, period.startDate, period.endDate)).limit(budget).getState()
}

export function datesQueryState(period: AnalysisPeriod, budget: FetchBudget): BuilderState {
  return gsc.select(dateCol).where(between(dateCol, period.startDate, period.endDate)).limit(budget).getState()
}
