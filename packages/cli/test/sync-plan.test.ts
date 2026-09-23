import { describe, expect, it } from 'vitest'
import { planHealDates, planSyncJobs } from '../src/sync-plan'

describe('planHealDates', () => {
  const today = '2026-06-30'
  const { jobs } = planSyncJobs(['pages', 'hourly_pages'], ['web'])

  it('drops hourly failed dates outside Google\'s hourly window', () => {
    const heal = planHealDates({
      jobs,
      failed: [
        { table: 'pages', date: '2026-03-01' },
        { table: 'hourly_pages', date: '2026-03-01' },
        { table: 'hourly_pages', searchType: 'web', date: '2026-06-25' },
      ],
      rangeDates: [],
      today,
    })
    expect(Object.fromEntries(heal)).toEqual({ pages: ['2026-03-01'], hourly_pages: ['2026-06-25'] })
  })

  it('skips dates the range already covers and dates Google no longer keeps', () => {
    const heal = planHealDates({
      jobs,
      failed: [
        { table: 'pages', date: '2026-06-29' },
        { table: 'pages', date: '2024-01-01' },
        { table: 'pages', searchType: 'discover', date: '2026-05-01' },
      ],
      rangeDates: ['2026-06-29'],
      today,
    })
    expect(heal.size).toBe(0)
  })
})
