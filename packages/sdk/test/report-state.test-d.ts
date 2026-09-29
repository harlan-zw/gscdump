import type { GscdumpV1Client } from '../src/v1/http'
import { and, between, clicks, contains, date, gsc, impressions, query } from 'gscdump/query'
import { describe, expectTypeOf, it } from 'vitest'

type ReportInput = Parameters<GscdumpV1Client['queryAnalyticsReport']>[0]
type ReportState = ReportInput['body']['state']
type DetailState = Parameters<GscdumpV1Client['queryAnalyticsReportDetail']>[0]['body']['state']

// The query builder is the documented way to write a Report state, so its
// output must pass straight into the SDK. `BuilderState` was an interface,
// which lacks the implicit index signature the contract's loose object needs,
// and callers had to spread it (`{ ...state }`) to compile.
describe('Report state', () => {
  it('accepts query-builder state for a list Report', () => {
    const state = gsc.select(query, clicks, impressions).where(between(date, '2026-01-01', '2026-01-31')).getState()
    expectTypeOf(state).toExtend<ReportState>()
  })

  it('accepts query-builder state for a detail Report', () => {
    const state = gsc.select(date, clicks).where(between(date, '2026-01-01', '2026-01-31')).getState()
    expectTypeOf(state).toExtend<DetailState>()
  })
})

type RowsFilter = Parameters<GscdumpV1Client['queryAnalyticsRows']>[0]['body']['filter']

describe('Rows filter', () => {
  it('accepts query-builder filters', () => {
    expectTypeOf(and(between(date, '2026-01-01', '2026-01-31'), contains(query, 'seo'))).toExtend<RowsFilter>()
  })
})
