import { describe, expect, it } from 'vitest'
import { coerceRowMetrics, positionFor, summarizeDailyRows } from '../src/gsc-rows'

describe('gsc row metric coercion', () => {
  it('converts 1-indexed GSC position to engine-compatible sum_position', () => {
    const row = coerceRowMetrics({ impressions: 2, position: 3 })

    expect(row.sum_position).toBe(4)
    expect(positionFor(row)).toBe(3)
  })

  it('summarizes free-tier rows without shifting average position', () => {
    const summary = summarizeDailyRows([
      { date: '2026-05-10', clicks: 1, impressions: 2, position: 3 },
    ])

    expect(summary.totals.position).toBe(3)
  })

  it('sorts once-shaped rows while preserving explicit sums and chart output', () => {
    const summary = summarizeDailyRows([
      { date: '2026-05-11', clicks: 2, impressions: 4, sum_position: 20, position: 99 },
      { date: '2026-05-10', clicks: 1, impressions: 2, position: 3 },
    ])

    expect(summary.daily).toEqual([
      { date: '2026-05-10', clicks: 1, impressions: 2, sum_position: 4 },
      { date: '2026-05-11', clicks: 2, impressions: 4, sum_position: 20 },
    ])
    expect(summary.chartData).toEqual([
      { date: '2026-05-10', clicks: 1, impressions: 2 },
      { date: '2026-05-11', clicks: 2, impressions: 4 },
    ])
    expect(summary.totals).toEqual({ clicks: 3, impressions: 6, ctr: 0.5, position: 5 })
  })
})
