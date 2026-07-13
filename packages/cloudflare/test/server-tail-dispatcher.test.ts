import type {
  ArbitrarySqlQuery,
  AuxCloudOnlyQuery,
  SiteDailyTimeseriesQuery,
  TopNBreakdownQuery,
} from '@gscdump/contracts/archetypes'
import { describe, expect, it, vi } from 'vitest'
import {
  createServerTailDispatcher,
  resolveServerTailEngine,
  resolveServerTailEngineResult,
  ServerTailRoutingError,
} from '../src/server-tail/dispatcher'
import { createDuckDbIcebergExecutor } from '../src/server-tail/duckdb-iceberg-executor'
import { createR2SqlClient } from '../src/server-tail/r2-sql-client'

const range = { start: '2026-01-01', end: '2026-03-31' }
const base = { siteId: 'site-1', searchType: 'web' as const, range }

function fakeFetch(rows: unknown[]) {
  return vi.fn(async (_url: string, _opts?: RequestInit) => ({
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

  it('keeps a top-n-breakdown with includeTotal on r2-sql (COUNT(*) OVER() verified working 2026-07-03)', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'page',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 20,
      includeTotal: true,
    }
    expect(resolveServerTailEngine(q)).toBe('r2-sql')
  })

  it('keeps a compareRange top-n-breakdown on r2-sql (CTE + FULL OUTER JOIN verified working 2026-07-03)', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'page',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 20,
      compareRange: { start: '2025-10-01', end: '2025-12-31' },
    }
    expect(resolveServerTailEngine(q)).toBe('r2-sql')
  })

  it('keeps a top-n-breakdown with BOTH compareRange and includeTotal on r2-sql (combined shape verified working 2026-07-03)', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'page',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 20,
      compareRange: { start: '2025-10-01', end: '2025-12-31' },
      includeTotal: true,
    }
    expect(resolveServerTailEngine(q)).toBe('r2-sql')
  })

  it('still escalates a queryCanonical-dimensioned breakdown to duckdb (query_dim sidecar table is not an Iceberg table, independent of COUNT(DISTINCT) support)', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'queryCanonical',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 20,
    }
    expect(resolveServerTailEngine(q)).toBe('duckdb')
  })

  it('escalates a top-n-breakdown with non-zero offset to duckdb, still confirmed unsupported', () => {
    // Distinct from the generic offset test above: OFFSET is CONFIRMED
    // rejected by R2 SQL (`[40003] OFFSET clause is not supported`,
    // 2026-07-03), not merely "unverified" as the original POC comment said.
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'page',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 20,
      offset: 1,
    }
    expect(resolveServerTailEngine(q)).toBe('duckdb')
  })

  it('escalates a faceted (brand regex) query to duckdb', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
      facets: [{ column: 'query', op: 'regex', value: '(nuxt seo)' }],
    }
    expect(resolveServerTailEngine(q)).toBe('duckdb')
    // same query without the facet stays on r2-sql
    expect(resolveServerTailEngine({ ...q, facets: undefined })).toBe('r2-sql')
    // equality facets compile to plain predicates and stay on r2-sql
    expect(resolveServerTailEngine({ ...q, facets: [{ column: 'query', op: 'eq', value: 'nuxt seo' }] })).toBe('r2-sql')
  })

  it('escalates a queryCanonical EQUALITY facet on another dimension to duckdb (facet compiles to a query_dim subquery; R2 SQL throws [40010] iceberg table not found "gsc.query_dim")', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 12,
      facets: [{ column: 'queryCanonical', op: 'eq', value: 'sitemap validator' }],
    }
    expect(resolveServerTailEngine(q)).toBe('duckdb')
  })

  it('escalates an entity-daily-sparkline over queryCanonical to duckdb; plain query stays r2-sql', () => {
    const q = {
      ...base,
      archetype: 'entity-daily-sparkline' as const,
      dimension: 'queryCanonical' as const,
      entities: ['sitemap validator'],
      metric: 'clicks' as const,
    }
    expect(resolveServerTailEngine(q)).toBe('duckdb')
    expect(resolveServerTailEngine({ ...q, dimension: 'query' as const })).toBe('r2-sql')
  })

  it('escalates single-row-lookup and multi-series-stacked-daily touching queryCanonical to duckdb', () => {
    expect(resolveServerTailEngine({
      ...base,
      archetype: 'single-row-lookup',
      match: { queryCanonical: 'sitemap validator' },
      metrics: ['clicks'],
    })).toBe('duckdb')
    expect(resolveServerTailEngine({
      ...base,
      archetype: 'multi-series-stacked-daily',
      seriesDimension: 'queryCanonical',
      metric: 'clicks',
    })).toBe('duckdb')
  })

  it('rejects a cloud-only archetype', () => {
    expect(() => resolveServerTailEngine({
      archetype: 'aux-cloud-only',
      siteId: 'site-1',
      dataset: 'sitemaps',
    } as AuxCloudOnlyQuery)).toThrow(ServerTailRoutingError)
  })
})

describe('resolveServerTailEngineResult', () => {
  it('returns ok with the engine for a routable archetype', () => {
    const res = resolveServerTailEngineResult({
      ...base,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
    } as SiteDailyTimeseriesQuery)
    expect(res).toEqual({ ok: true, value: 'r2-sql' })
  })

  it('returns err with a ServerTailRoutingError for a cloud-only archetype', () => {
    const res = resolveServerTailEngineResult({
      archetype: 'aux-cloud-only',
      siteId: 'site-1',
      dataset: 'sitemaps',
    } as AuxCloudOnlyQuery)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ServerTailRoutingError)
      expect(res.error.message).toMatch(/cloud-only/)
    }
  })
})

describe('createServerTailDispatcher', () => {
  function makeDispatcher(r2Rows: unknown[], duckRows: unknown[]) {
    const fetchImpl = fakeFetch(r2Rows)
    const r2Sql = createR2SqlClient({
      accountId: 'a',
      bucket: 'w',
      namespace: 'gsc',
      token: 't',
      fetchImpl,
      partitionSiteId: siteId => (siteId === 'site-1' ? 1 : siteId),
    })
    const svc = fakeSvc(duckRows)
    const duckdb = createDuckDbIcebergExecutor({ svc, warehouse: 'w', namespace: 'gsc' })
    return { dispatcher: createServerTailDispatcher({ r2Sql, duckdb }), fetchImpl, svc }
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

  it('executes a brand-faceted breakdown via duckdb with regexp_matches in the SQL', async () => {
    const { dispatcher, svc } = makeDispatcher([], [{ query: 'nuxt seo', clicks: 9 }])
    const res = await dispatcher.execute({
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
      facets: [{ column: 'query', op: 'regex', value: '(nuxt seo)' }],
    } as TopNBreakdownQuery)
    expect(res.source).toBe('server-duckdb')
    expect(res.rows).toEqual([{ query: 'nuxt seo', clicks: 9 }])
    // the facet predicate is compiled into the SQL the DuckDB sibling runs;
    // runPlan binds the `?` param as a literal, so assert the bound form.
    expect(svc.calls[0]).toContain('regexp_matches(LOWER(query), \'(nuxt seo)\')')
  })

  it('keeps equality-faceted breakdowns on R2 SQL', async () => {
    const { dispatcher, fetchImpl, svc } = makeDispatcher([{ query: 'nuxt seo', clicks: 9 }], [])
    const res = await dispatcher.execute({
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
      facets: [{ column: 'query', op: 'eq', value: 'nuxt seo' }],
    } as TopNBreakdownQuery)
    expect(res.source).toBe('server-r2-sql')
    expect(res.rows).toEqual([{ query: 'nuxt seo', clicks: 9 }])
    expect(svc.runSQL).not.toHaveBeenCalled()
    const [, opts] = fetchImpl.mock.calls[0]!
    const sentSql = JSON.parse(opts!.body as string).query as string
    expect(sentSql).toContain('query = \'nuxt seo\'')
  })

  it('extracts includeTotal metadata from R2 SQL rows', async () => {
    const { dispatcher, svc } = makeDispatcher([{ page: '/a', clicks: 9, __total: 42 }], [])
    const res = await dispatcher.execute({
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'page',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 20,
      includeTotal: true,
    } as TopNBreakdownQuery)

    expect(res.source).toBe('server-r2-sql')
    expect(res.rows).toEqual([{ page: '/a', clicks: 9 }])
    expect(res.meta?.rowCount).toBe(1)
    expect(res.meta?.totalRows).toBe(42)
    expect(svc.runSQL).not.toHaveBeenCalled()
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
