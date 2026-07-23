import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGscUnstableCutoffDate, periodToDateRange, periodToDays } from '../src/period'

afterEach(() => {
  vi.useRealTimers()
})

describe('period helpers', () => {
  it('retains the boolean stable-data argument', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'))

    expect(periodToDateRange('7d', false)).toMatchObject({
      start: '2026-07-12',
      end: '2026-07-18',
      days: 7,
    })
    expect(periodToDays('28d', false)).toBe(28)
  })

  it('resolves today in a consumer-supplied IANA timezone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T00:30:00Z'))

    expect(periodToDateRange('7d', { stableData: false, timezone: 'UTC' }).end).toBe('2026-07-18')
    expect(periodToDateRange('7d', { stableData: false, timezone: 'America/Los_Angeles' }).end).toBe('2026-07-17')
  })

  it('accepts an injected clock for deterministic server windows', () => {
    expect(periodToDateRange('28d', { now: new Date('2026-07-19T00:30:00Z') })).toMatchObject({
      start: '2026-06-18',
      end: '2026-07-15',
      prevStart: '2026-05-21',
      prevEnd: '2026-06-17',
      days: 28,
    })
  })

  it('preserves calendar presets across a leap-month boundary', () => {
    const options = {
      stableData: false,
      timezone: 'America/Los_Angeles',
      now: new Date('2024-03-01T12:00:00Z'),
    } as const

    expect(periodToDateRange('this-week', options)).toMatchObject({ start: '2024-02-26', end: '2024-02-29' })
    expect(periodToDateRange('this-month', options)).toMatchObject({ start: '2024-02-01', end: '2024-02-29' })
    expect(periodToDateRange('last-month', options)).toMatchObject({ start: '2024-01-01', end: '2024-01-31' })
    expect(periodToDateRange('this-quarter', options)).toMatchObject({ start: '2024-01-01', end: '2024-02-29' })
    expect(periodToDateRange('this-year', options)).toMatchObject({ start: '2024-01-01', end: '2024-02-29' })
  })

  it('exposes the GSC/Pacific unstable-data cutoff', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'))

    expect(getGscUnstableCutoffDate()).toBe('2026-07-16')
  })
})
