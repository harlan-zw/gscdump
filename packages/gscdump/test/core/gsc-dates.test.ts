import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, generateGscDateRange, getBackfillProgress, getFreshestGscDate, getOldestGscDate } from '../../src/core/gsc-dates'
import { currentPstDate, daysAgoPst } from '../../src/query/utils/dayjs'

describe('gsc date helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clamps generated ranges to the GSC queryable window', () => {
    vi.setSystemTime(new Date('2026-07-06T12:00:00.000Z'))
    const oldest = getOldestGscDate()
    const freshest = getFreshestGscDate()

    expect(generateGscDateRange(addDays(oldest, -5), addDays(oldest, 2))).toEqual([
      oldest,
      addDays(oldest, 1),
      addDays(oldest, 2),
    ])
    expect(generateGscDateRange(addDays(freshest, -1), addDays(freshest, 5))).toEqual([addDays(freshest, -1), freshest])
  })

  it('counts synced and available backfill days inclusively', () => {
    vi.setSystemTime(new Date('2026-07-06T12:00:00.000Z'))

    const progress = getBackfillProgress('2026-07-04', '2026-07-04')

    expect(progress?.daysSynced).toBe(1)
    expect(progress?.daysAvailable).toBeGreaterThan(1)
  })

  it('subtracts Pacific calendar days across leap day and daylight saving time', () => {
    vi.setSystemTime(new Date('2024-03-01T07:30:00Z'))
    expect(currentPstDate()).toBe('2024-02-29')
    expect(daysAgoPst(1)).toBe('2024-02-28')

    vi.setSystemTime(new Date('2024-03-11T07:30:00Z'))
    expect(currentPstDate()).toBe('2024-03-11')
    expect(daysAgoPst(1)).toBe('2024-03-10')
  })
})
