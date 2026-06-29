import type { BuilderState } from 'gscdump/query'
import type { RunSQLFn } from '../src/resolver/run-query'
import { describe, expect, it } from 'vitest'
import { QuerySourceCoverageError, runOptimizedQuery } from '../src/resolver/run-query'

const ctx = { userId: 'u1', siteId: 's1', table: 'pages' as const }
const dateRange = { startDate: '2026-03-01', endDate: '2026-03-31' }

const pageState: BuilderState = {
  dimensions: ['page'],
  filter: {
    _filters: [{ dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' }],
  } as any,
}

function recordingRunSQL(calls: Parameters<RunSQLFn>[0][]): RunSQLFn {
  return async (opts) => {
    calls.push(opts)
    return {
      rows: [{
        page: '/a',
        clicks: 7,
        impressions: 70,
        ctr: 0.1,
        position: 3,
        totalCount: 1,
        totalClicks: 7,
        totalImpressions: 70,
        totalCtr: 0.1,
        totalPosition: 3,
      }],
    }
  }
}

describe('runOptimizedQuery primary source routing', () => {
  it('uses compacted/Iceberg keys when primary coverage is present', async () => {
    const calls: Parameters<RunSQLFn>[0][] = []
    const result = await runOptimizedQuery(recordingRunSQL(calls), ctx, pageState, dateRange, {
      primarySource: {
        keys: ['iceberg/pages/data-1.parquet'],
        coversFrom: '2026-01-01',
        coversThrough: '2026-03-31',
      },
    })

    expect(result.source).toEqual({ kind: 'primary-columnar' })
    expect(calls[0]!.fileSets.FILES).toEqual({
      table: 'pages',
      keys: ['iceberg/pages/data-1.parquet'],
    })
  })

  it('fails when primary coverage is missing by default', async () => {
    const calls: Parameters<RunSQLFn>[0][] = []
    await expect(runOptimizedQuery(recordingRunSQL(calls), ctx, pageState, dateRange)).rejects.toMatchObject({
      fallback: { kind: 'primary-source-missing' },
    })
    expect(calls).toEqual([])
  })

  it('fails stale primary coverage by default', async () => {
    const calls: Parameters<RunSQLFn>[0][] = []
    await expect(runOptimizedQuery(recordingRunSQL(calls), ctx, pageState, dateRange, {
      primarySource: {
        keys: ['iceberg/pages/data-1.parquet'],
        coversThrough: '2026-03-10',
      },
    })).rejects.toBeInstanceOf(QuerySourceCoverageError)
    await expect(runOptimizedQuery(recordingRunSQL([]), ctx, pageState, dateRange, {
      primarySource: {
        keys: ['iceberg/pages/data-1.parquet'],
        coversThrough: '2026-03-10',
      },
    })).rejects.toMatchObject({
      fallback: { kind: 'primary-source-stale-coverage' },
    })
    expect(calls).toEqual([])
  })

  it('uses raw daily partitions only when the fallback is explicit', async () => {
    const calls: Parameters<RunSQLFn>[0][] = []
    const result = await runOptimizedQuery(recordingRunSQL(calls), ctx, pageState, dateRange, {
      primarySourceFallback: 'raw',
    })

    expect(result.source).toMatchObject({
      kind: 'raw-partitions',
      fallback: { kind: 'primary-source-missing' },
    })
    expect(calls[0]!.fileSets.FILES).toMatchObject({ table: 'pages' })
    expect(calls[0]!.fileSets.FILES.partitions).toContain('daily/2026-03-01')
    expect(calls[0]!.fileSets.FILES.partitions).toContain('daily/2026-03-31')
  })
})
