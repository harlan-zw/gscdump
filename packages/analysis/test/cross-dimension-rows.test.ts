/**
 * Row-query plans for `data-query` / `data-detail` — the cross-dimension
 * fallback. `build*Rows` emits the `BuilderState` set; `shape*RowResults`
 * reduces the per-query row map the dispatcher collects from `queryRows`.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { between, clicks, ctr, date, gsc, impressions, position, query } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import {
  buildDataDetailRows,
  buildDataQueryRows,
  shapeDataDetailRowResults,
  shapeDataQueryRowResults,
} from '../src/query'

const keywordBreakdown = gsc
  .select(query, clicks, impressions, ctr, position)
  .where(between(date, '2026-01-01', '2026-01-31'))
  .orderBy(clicks, 'desc')
  .getState()

const keywordTimeseries = gsc
  .select(date, clicks, impressions, ctr, position)
  .where(between(date, '2026-01-01', '2026-01-31'))
  .getState()

describe('buildDataQueryRows', () => {
  it('emits a main + totals plan for a plain breakdown', () => {
    const plan = buildDataQueryRows({ type: 'data-query', q: keywordBreakdown } as AnalysisParams)
    expect(Object.keys(plan).sort()).toEqual(['main', 'totals'])
    expect(plan.main.dimensions).toEqual(['query'])
    expect(plan.totals.dimensions).toEqual([])
    expect(plan.totals.rowLimit).toBe(1)
  })

  it('adds previous-period queries for a comparison', () => {
    const plan = buildDataQueryRows({ type: 'data-query', q: keywordBreakdown, qc: keywordBreakdown } as AnalysisParams)
    expect(Object.keys(plan).sort()).toEqual(['main', 'prevMain', 'prevTotals', 'totals'])
  })

  it('rejects a date dimension (use data-detail)', () => {
    expect(() => buildDataQueryRows({ type: 'data-query', q: keywordTimeseries } as AnalysisParams))
      .toThrow(/date dimension not supported/)
  })
})

describe('shapeDataQueryRowResults', () => {
  it('returns rows + totals for a plain breakdown', () => {
    const out = shapeDataQueryRowResults({
      main: [{ query: 'seo', clicks: 10, impressions: 100, ctr: 0.1, position: 3 }],
      totals: [{ clicks: 10, impressions: 100, ctr: 0.1, position: 3 }],
    }, { type: 'data-query', q: keywordBreakdown } as AnalysisParams)
    expect(out.results).toHaveLength(1)
    expect(out.meta.totalCount).toBe(1)
    expect(out.meta.totals).toEqual({ clicks: 10, impressions: 100, ctr: 0.1, position: 3 })
  })

  it('joins current + previous rows into prev* fields for a comparison', () => {
    const params = { type: 'data-query', q: keywordBreakdown, qc: keywordBreakdown } as AnalysisParams
    const out = shapeDataQueryRowResults({
      main: [{ query: 'seo', clicks: 12, impressions: 100, ctr: 0.12, position: 3 }],
      totals: [{ clicks: 12, impressions: 100, ctr: 0.12, position: 3 }],
      prevMain: [{ query: 'seo', clicks: 8, impressions: 90, ctr: 0.09, position: 4 }],
      prevTotals: [{ clicks: 8, impressions: 90, ctr: 0.09, position: 4 }],
    }, params)
    expect(out.results).toHaveLength(1)
    const row = out.results[0] as Record<string, number>
    expect(row.clicks).toBe(12)
    expect(row.prevClicks).toBe(8)
    expect(row.prevPosition).toBe(4)
  })

  it('surfaces `lost` keywords (previous-only) under the lost filter', () => {
    const params = { type: 'data-query', q: keywordBreakdown, qc: keywordBreakdown, comparisonFilter: 'lost' } as AnalysisParams
    const out = shapeDataQueryRowResults({
      main: [{ query: 'kept', clicks: 5, impressions: 50, ctr: 0.1, position: 2 }],
      totals: [{ clicks: 5, impressions: 50, ctr: 0.1, position: 2 }],
      prevMain: [
        { query: 'kept', clicks: 4, impressions: 40, ctr: 0.1, position: 2 },
        { query: 'gone', clicks: 9, impressions: 80, ctr: 0.11, position: 5 },
      ],
      prevTotals: [{ clicks: 13, impressions: 120, ctr: 0.1, position: 3 }],
    }, params)
    expect(out.results).toHaveLength(1)
    const row = out.results[0] as Record<string, unknown>
    expect(row.query).toBe('gone')
    expect(row.clicks).toBe(0)
    expect(row.prevClicks).toBe(9)
  })

  it('keeps only improving rows under the improving filter', () => {
    const params = { type: 'data-query', q: keywordBreakdown, qc: keywordBreakdown, comparisonFilter: 'improving' } as AnalysisParams
    const out = shapeDataQueryRowResults({
      main: [
        { query: 'up', clicks: 20, impressions: 100, ctr: 0.2, position: 2 },
        { query: 'down', clicks: 3, impressions: 100, ctr: 0.03, position: 8 },
      ],
      totals: [{ clicks: 23, impressions: 200, ctr: 0.1, position: 5 }],
      prevMain: [
        { query: 'up', clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
        { query: 'down', clicks: 9, impressions: 100, ctr: 0.09, position: 6 },
      ],
      prevTotals: [{ clicks: 19, impressions: 200, ctr: 0.1, position: 4 }],
    }, params)
    expect(out.results.map(r => (r as Record<string, unknown>).query)).toEqual(['up'])
  })
})

describe('buildDataDetailRows / shapeDataDetailRowResults', () => {
  it('emits main + totals, plus prevTotals for a comparison', () => {
    expect(Object.keys(buildDataDetailRows({ type: 'data-detail', q: keywordTimeseries } as AnalysisParams)).sort())
      .toEqual(['main', 'totals'])
    expect(Object.keys(buildDataDetailRows({ type: 'data-detail', q: keywordTimeseries, qc: keywordTimeseries } as AnalysisParams)).sort())
      .toEqual(['main', 'prevTotals', 'totals'])
  })

  it('pads the daily series across the requested range and reads totals', () => {
    const out = shapeDataDetailRowResults({
      main: [{ date: '2026-01-01', clicks: 5, impressions: 50, ctr: 0.1, position: 3 }],
      totals: [{ clicks: 5, impressions: 50, ctr: 0.1, position: 3 }],
    }, { type: 'data-detail', q: keywordTimeseries } as AnalysisParams)
    // padTimeseries fills every day in 2026-01-01..2026-01-31.
    expect(out.results).toHaveLength(31)
    expect(out.meta.totals).toEqual({ clicks: 5, impressions: 50, ctr: 0.1, position: 3 })
  })

  it('surfaces previousTotals when a comparison range is given', () => {
    const out = shapeDataDetailRowResults({
      main: [{ date: '2026-01-01', clicks: 5, impressions: 50, ctr: 0.1, position: 3 }],
      totals: [{ clicks: 5, impressions: 50, ctr: 0.1, position: 3 }],
      prevTotals: [{ clicks: 4, impressions: 40, ctr: 0.1, position: 4 }],
    }, { type: 'data-detail', q: keywordTimeseries, qc: keywordTimeseries } as AnalysisParams)
    expect(out.meta.previousTotals).toEqual({ clicks: 4, impressions: 40, ctr: 0.1, position: 4 })
  })
})
