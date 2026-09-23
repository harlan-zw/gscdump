import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { between, date, gsc } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { analysisNeeds } from '../src/analysis-local'

function dataQueryParams(params: Omit<AnalysisParams, 'type'>): AnalysisParams {
  return { type: 'data-query', ...params }
}

describe('analysisNeeds', () => {
  it('reads the table and dates off a BuilderState plan it cannot compile', () => {
    const q = gsc.select('page').where(between(date, '2026-08-01', '2026-08-03')).getState()
    expect(analysisNeeds(dataQueryParams({ q }))).toEqual([
      { kind: 'window', period: 'current', table: 'pages', searchType: 'web', window: { start: '2026-08-01', end: '2026-08-03' } },
    ])
  })

  it('falls back to an any-table need when the BuilderState has no dates', () => {
    const q = gsc.select('query').getState()
    expect(analysisNeeds(dataQueryParams({ q }))).toEqual([
      { kind: 'any', tables: ['queries'] },
    ])
  })

  it('covers both periods of a comparison BuilderState plan', () => {
    const q = gsc.select('page', 'query').where(between(date, '2026-08-01', '2026-08-03')).getState()
    const qc = gsc.select('page', 'query').where(between(date, '2026-07-01', '2026-07-03')).getState()
    expect(analysisNeeds(dataQueryParams({ q, qc }))).toEqual([
      { kind: 'window', period: 'current', table: 'page_queries', searchType: 'web', window: { start: '2026-08-01', end: '2026-08-03' } },
      { kind: 'window', period: 'comparison', table: 'page_queries', searchType: 'web', window: { start: '2026-07-01', end: '2026-07-03' } },
    ])
  })

  it('never reports an empty need list when the params carry no BuilderState', () => {
    expect(analysisNeeds(dataQueryParams({ startDate: '2026-08-01', endDate: '2026-08-03' }))).toEqual([
      { kind: 'any', tables: [] },
    ])
  })
})
