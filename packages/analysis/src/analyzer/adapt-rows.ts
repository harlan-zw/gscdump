/**
 * Canonical `BuilderState` factories for the three row shapes the portable
 * dispatcher uses: keywords (`query + page`), pages (`page`), dates (`date`).
 * Shared so every row-based analyzer composes its requirements from the same
 * primitives — adapt-rows pre-defineAnalyzer is gone; only the factories
 * remain.
 */

import type { BuilderState } from 'gscdump/query'
import type { AnalysisPeriod } from '@gscdump/engine/period'

import { between, date as dateCol, gsc, page as pageCol, query as queryCol } from 'gscdump/query'

const DEFAULT_LIMIT = 25_000

export function keywordsQueryState(period: AnalysisPeriod, limit: number = DEFAULT_LIMIT): BuilderState {
  return gsc.select(queryCol, pageCol).where(between(dateCol, period.startDate, period.endDate)).limit(limit).getState()
}

export function pagesQueryState(period: AnalysisPeriod, limit: number = DEFAULT_LIMIT): BuilderState {
  return gsc.select(pageCol).where(between(dateCol, period.startDate, period.endDate)).limit(limit).getState()
}

export function datesQueryState(period: AnalysisPeriod, limit: number = DEFAULT_LIMIT): BuilderState {
  return gsc.select(dateCol).where(between(dateCol, period.startDate, period.endDate)).limit(limit).getState()
}
