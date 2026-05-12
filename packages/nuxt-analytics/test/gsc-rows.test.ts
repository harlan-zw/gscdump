import { describe, expect, it } from 'vitest'
import { coerceRowMetrics, summarizeDailyRows } from '../app/utils/gsc-rows'

describe('coerceRowMetrics', () => {
  it('passes sum_position through when present', () => {
    const out = coerceRowMetrics({ clicks: 5, impressions: 100, sum_position: 250 })
    expect(out.sum_position).toBe(250)
  })

  it('derives sum_position from position * impressions when absent', () => {
    const out = coerceRowMetrics({ clicks: 5, impressions: 100, position: 2.5 })
    expect(out.sum_position).toBe(250)
  })

  it('handles missing position (free-tier zero-impression row)', () => {
    const out = coerceRowMetrics({ clicks: 0, impressions: 0 })
    expect(out.sum_position).toBe(0)
  })

  it('preserves extra row fields', () => {
    const out = coerceRowMetrics({ url: '/x', clicks: 1, impressions: 10, position: 5 })
    expect(out).toMatchObject({ url: '/x', clicks: 1, impressions: 10, sum_position: 50 })
  })
})

describe('summarizeDailyRows', () => {
  it('sorts by date asc and reduces totals', () => {
    const summary = summarizeDailyRows([
      { date: '2025-01-02', clicks: 10, impressions: 100, sum_position: 200 },
      { date: '2025-01-01', clicks: 5, impressions: 50, sum_position: 150 },
    ])
    expect(summary.daily.map(d => d.date)).toEqual(['2025-01-01', '2025-01-02'])
    expect(summary.totals.clicks).toBe(15)
    expect(summary.totals.impressions).toBe(150)
    expect(summary.totals.ctr).toBeCloseTo(15 / 150)
    // weightedPosition = 350; 350/150 = 2.333…; +1 = 3.333…
    expect(summary.totals.position).toBeCloseTo(350 / 150 + 1)
  })

  it('coerces position rows the same as sum_position rows', () => {
    const a = summarizeDailyRows([{ date: '2025-01-01', clicks: 1, impressions: 10, position: 4 }])
    const b = summarizeDailyRows([{ date: '2025-01-01', clicks: 1, impressions: 10, sum_position: 40 }])
    expect(a.totals).toEqual(b.totals)
  })

  it('zero-impression input returns zero ctr + zero position', () => {
    const summary = summarizeDailyRows([{ date: '2025-01-01', clicks: 0, impressions: 0 }])
    expect(summary.totals.ctr).toBe(0)
    expect(summary.totals.position).toBe(0)
  })

  it('chartData drops sum_position', () => {
    const summary = summarizeDailyRows([{ date: '2025-01-01', clicks: 1, impressions: 10, sum_position: 50 }])
    expect(summary.chartData).toEqual([{ date: '2025-01-01', clicks: 1, impressions: 10 }])
  })

  it('empty input is a no-op', () => {
    expect(summarizeDailyRows([])).toEqual({ daily: [], totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, chartData: [] })
  })
})
