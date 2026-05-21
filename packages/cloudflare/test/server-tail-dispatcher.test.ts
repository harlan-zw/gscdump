import type {
  ArbitrarySqlQuery,
  AuxCloudOnlyQuery,
  SiteDailyTimeseriesQuery,
  TopNBreakdownQuery,
} from '@gscdump/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  createServerTailDispatcher,
  resolveServerTailEngine,
  ServerTailRoutingError,
} from '../src/server-tail/dispatcher'
import { createDuckDbIcebergExecutor } from '../src/server-tail/duckdb-iceberg-executor'
import { createR2SqlClient } from '../src/server-tail/r2-sql-client'

const range = { start: '2026-01-01', end: '2026-03-31' }
const base = { siteId: 'site-1', searchType: 'web' as const, range }

function fakeFetch(rows: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { rows } }),
    text: async () => '',
  } as unknown as Response))
}

/** Fake DUCKDB_SVC: records the SQL it was handed, echoes back recorded rows. */
function fakeSvc(rows: unknown[]) {
  const calls: string[] = []
  return {
    calls,
    runSQL: vi.fn(async ({ sql }: { sql: string }) => {
      calls.push(sql)
      return { rows, sql }
    }),
  }
}

describe('resolveServerTailEngine', () => {
  it('routes r2-sql archetypes to r2-sql', () => {
    expect(resolveServerTailEngine({
      ...base,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
    } as SiteDailyTimeseriesQuery)).toBe('r2-sql')
  })

  it('routes arbitrary-sql to duckdb', () => {
    expect(resolveServerTailEngine({
      ...base,
      archetype: 'arbitrary-sql',
      sql: 'SELECT 1',
    } as ArbitrarySqlQuery)).toBe('duckdb')
  })

  it('escalates a top-n-breakdown with non-zero offset to duckdb', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'page',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 20,
      offset: 20,
    }
    expect(resolveServerTailEngine(q)).toBe('duckdb')
    expect(resolveServerTailEngine({ ...q, offset: 0 })).toBe('r2-sql')
  })

  it('rejects a cloud-only archetype', () => {
    expect(() => resolveServerTailEngine({
      archetype: 'aux-cloud-only',
      siteId: 'site-1',
      dataset: 'sitemaps',
    } as AuxCloudOnlyQuery)).toThrow(ServerTailRoutingError)
  })
})

describe('createServerTailDispatcher', () => {
  function makeDispatcher(r2Rows: unknown[], duckRows: unknown[]) {
    const r2Sql = createR2SqlClient({
      accountId: 'a',
      warehouse: 'w',
      namespace: 'gsc',
      token: 't',
      fetchImpl: fakeFetch(r2Rows),
    })
    const svc = fakeSvc(duckRows)
    const duckdb = createDuckDbIcebergExecutor({ svc, warehouse: 'w', namespace: 'gsc' })
    return { dispatcher: createServerTailDispatcher({ r2Sql, duckdb }), svc }
  }

  it('runs an r2-sql archetype via the R2 SQL client', async () => {
    const { dispatcher, svc } = makeDispatcher([{ date: '2026-01-01', clicks: 3 }], [])
    const res = await dispatcher.execute({
      ...base,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
    } as SiteDailyTimeseriesQuery)
    expect(res.source).toBe('server-r2-sql')
    expect(res.rows).toEqual([{ date: '2026-01-01', clicks: 3 }])
    expect(res.meta?.rowCount).toBe(1)
    expect(svc.runSQL).not.toHaveBeenCalled()
  })

  it('runs an arbitrary-sql archetype via the DuckDB executor', async () => {
    const { dispatcher, svc } = makeDispatcher([], [{ rank: 1 }])
    const res = await dispatcher.execute({
      ...base,
      archetype: 'arbitrary-sql',
      sql: 'SELECT rank() OVER (ORDER BY clicks) AS rank FROM {{pages}}',
    } as ArbitrarySqlQuery)
    expect(res.source).toBe('server-duckdb')
    expect(res.rows).toEqual([{ rank: 1 }])
    // {{pages}} placeholder resolved to an iceberg_scan reference
    expect(svc.calls[0]).toContain('iceberg_scan(\'w/gsc/pages\')')
    expect(svc.calls[0]).toMatch(/OVER\s*\(/)
  })

  it('route() reports the engine without executing', () => {
    const { dispatcher } = makeDispatcher([], [])
    expect(dispatcher.route({
      ...base,
      archetype: 'two-dimension-detail',
      metrics: ['clicks'],
    } as any)).toBe('r2-sql')
  })
})
