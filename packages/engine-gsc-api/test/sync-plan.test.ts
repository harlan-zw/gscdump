import { gscSyncFanout, ledgerTablesForGscSync, planGscBackfillDates, planGscSyncWork, tablesCoveredByGscSync } from '@gscdump/engine-gsc-api'
import { describe, expect, it } from 'vitest'

describe('sync coverage plan', () => {
  it('builds web and Discover fanout without a redundant web dates job', () => {
    expect(gscSyncFanout(['web', 'discover'], { omitWebDates: true })).toEqual([
      { table: 'pages' },
      { table: 'queries' },
      { table: 'countries' },
      { table: 'page_queries' },
      { table: 'pages', searchType: 'discover' },
      { table: 'countries', searchType: 'discover' },
      { table: 'dates', searchType: 'discover' },
    ])
  })

  it('repairs a missing dates table with the web queries slice', () => {
    const plan = planGscSyncWork({
      dates: ['2026-09-01', '2026-09-02'],
      fanout: [{ table: 'pages' }, { table: 'queries' }, { table: 'dates' }],
      ledger: [
        { table: 'pages', searchType: 'web', date: '2026-09-01' },
        { table: 'pages', searchType: 'web', date: '2026-09-02' },
        { table: 'queries', searchType: 'web', date: '2026-09-01' },
        { table: 'queries', searchType: 'web', date: '2026-09-02' },
        { table: 'dates', searchType: 'web', date: '2026-09-01' },
      ],
      pagesPerDayEstimate: 100,
    })

    expect(plan.windows).toEqual([{ table: 'queries', startDate: '2026-09-02', endDate: '2026-09-02' }])
    expect(plan.missingDates).toEqual(['2026-09-02'])
  })

  it('keeps non-web dates as their own slice', () => {
    const plan = planGscSyncWork({
      dates: ['2026-09-01'],
      fanout: [{ table: 'queries', searchType: 'discover' }, { table: 'dates', searchType: 'discover' }],
      ledger: [{ table: 'queries', searchType: 'discover', date: '2026-09-01' }],
    })

    expect(plan.windows).toEqual([{ table: 'dates', searchType: 'discover', startDate: '2026-09-01', endDate: '2026-09-01' }])
    expect(ledgerTablesForGscSync([{ table: 'queries' }, { table: 'dates' }])).toEqual(['queries', 'dates'])
    expect(tablesCoveredByGscSync({ table: 'dates' })).toEqual([])
  })

  it('sizes sparse Backfill windows and bounds dense Sync windows', () => {
    const validDates = Array.from({ length: 120 }, (_, index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10))
    const sparse = planGscSyncWork({
      dates: validDates,
      fanout: [{ table: 'pages' }],
      ledger: [],
      pagesPerDayEstimate: 0.64,
      maxSpanDays: 120,
    })
    const dense = planGscSyncWork({
      dates: validDates.slice(0, 7),
      fanout: [{ table: 'page_queries' }],
      ledger: [],
      pagesPerDayEstimate: 5000,
    })

    expect(sparse.windows).toEqual([{ table: 'pages', startDate: '2026-01-01', endDate: '2026-04-30' }])
    expect(dense.windows).toHaveLength(7)
    expect(dense.windows[0]).toEqual({ table: 'page_queries', startDate: '2026-01-01', endDate: '2026-01-01' })
  })
})

describe('backfill dates', () => {
  it('fills only interior gaps', () => {
    expect(planGscBackfillDates({
      _tag: 'repair',
      oldestCoveredDate: '2026-09-02',
      newestAvailableDate: '2026-09-05',
      coveredDates: ['2026-09-02', '2026-09-04'],
      targetDays: 2,
    })).toEqual(['2026-09-03', '2026-09-05'])
  })

  it('extends backward from the supplied boundary', () => {
    expect(planGscBackfillDates({
      _tag: 'backfill',
      startFromDate: '2026-09-03',
      oldestAvailableDate: '2026-09-01',
      targetDays: 10,
      maxDays: 2,
    })).toEqual(['2026-09-03', '2026-09-02'])
  })
})
