import { padTimeseries } from '@gscdump/engine/period'
import { describe, expect, it } from 'vitest'

describe('padTimeseries', () => {
  it('fills gaps between sparse dates', () => {
    const rows = [
      { date: '2026-04-10', clicks: 5, impressions: 50, ctr: 0.1, position: 3 },
      { date: '2026-04-13', clicks: 2, impressions: 20, ctr: 0.1, position: 4 },
    ]
    const out = padTimeseries(rows, { startDate: '2026-04-10', endDate: '2026-04-14' })
    expect(out.map(r => r.date)).toEqual([
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
      '2026-04-13',
      '2026-04-14',
    ])
    expect(out[1]).toEqual({ date: '2026-04-11', clicks: 0, impressions: 0, ctr: 0, position: 0 })
    expect(out[0]!.clicks).toBe(5)
  })

  it('preserves grouped rows (multiple entries per date)', () => {
    const rows = [
      { date: '2026-04-10', device: 'mobile', clicks: 5 },
      { date: '2026-04-10', device: 'desktop', clicks: 3 },
      { date: '2026-04-12', device: 'mobile', clicks: 1 },
    ]
    const out = padTimeseries(rows, { startDate: '2026-04-10', endDate: '2026-04-12' })
    expect(out).toHaveLength(4)
    expect(out.filter(r => r.date === '2026-04-10')).toHaveLength(2)
    expect(out[2]!.date).toBe('2026-04-11')
  })

  it('accepts a custom fill shape', () => {
    const rows: { date: string, count: number | null }[] = []
    const out = padTimeseries(rows, {
      startDate: '2026-04-10',
      endDate: '2026-04-11',
      fill: { count: null },
    })
    expect(out).toEqual([
      { date: '2026-04-10', count: null },
      { date: '2026-04-11', count: null },
    ])
  })

  it('supports a custom dateKey', () => {
    const rows = [{ day: '2026-04-10', v: 1 }]
    const out = padTimeseries(rows, {
      startDate: '2026-04-10',
      endDate: '2026-04-11',
      dateKey: 'day',
      fill: { v: 0 },
    })
    expect(out).toEqual([
      { day: '2026-04-10', v: 1 },
      { day: '2026-04-11', v: 0 },
    ])
  })

  it('returns empty array when start > end (range yields no dates)', () => {
    expect(padTimeseries([], { startDate: '2026-04-11', endDate: '2026-04-10' })).toEqual([])
  })

  it('single-date range returns exactly one row', () => {
    const out = padTimeseries([], { startDate: '2026-04-10', endDate: '2026-04-10' })
    expect(out).toHaveLength(1)
    expect(out[0]!.date).toBe('2026-04-10')
  })

  it('rejects invalid dates', () => {
    expect(() => padTimeseries([], { startDate: 'not-a-date', endDate: '2026-04-10' })).toThrow(/invalid date range/)
  })
})
