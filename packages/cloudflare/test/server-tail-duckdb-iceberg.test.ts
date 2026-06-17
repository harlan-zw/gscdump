import type { ArbitrarySqlQuery, TwoDimensionDetailQuery } from '@gscdump/contracts/archetypes'
import { describe, expect, it, vi } from 'vitest'
import {
  createDuckDbIcebergExecutor,
  DuckDbIcebergError,
} from '../src/server-tail/duckdb-iceberg-executor'

const range = { start: '2026-01-01', end: '2026-03-31' }
const base = { siteId: 'site-1', searchType: 'web' as const, range }

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

describe('createDuckDbIcebergExecutor', () => {
  it('runArchetype on a non-arbitrary archetype scans the Iceberg table by path', async () => {
    const svc = fakeSvc([{ url: 'a', query: 'b', clicks: 1 }])
    const exec = createDuckDbIcebergExecutor({ svc, warehouse: 'wh', namespace: 'gsc' })
    const q: TwoDimensionDetailQuery = {
      ...base,
      archetype: 'two-dimension-detail',
      metrics: ['clicks'],
    }
    const res = await exec.runArchetype(q)
    expect(res.rows).toEqual([{ url: 'a', query: 'b', clicks: 1 }])
    // {{TABLE}} resolved to a path-style iceberg_scan, params bound as literals
    expect(svc.calls[0]).toContain('iceberg_scan(\'wh/gsc/page_queries\')')
    expect(svc.calls[0]).not.toContain('?')
    expect(svc.calls[0]).toContain('\'site-1\'')
  })

  it('uses catalog-style table refs when configured', async () => {
    const svc = fakeSvc([])
    const exec = createDuckDbIcebergExecutor({
      svc,
      warehouse: 'wh',
      namespace: 'gsc',
      tableRefStyle: 'catalog',
    })
    await exec.runArchetype({
      ...base,
      archetype: 'two-dimension-detail',
      metrics: ['clicks'],
    } as TwoDimensionDetailQuery)
    expect(svc.calls[0]).toContain('FROM gsc.page_queries')
  })

  it('runs arbitrary-sql verbatim, resolving table placeholders and binding params', async () => {
    const svc = fakeSvc([{ n: 1 }])
    const exec = createDuckDbIcebergExecutor({ svc, warehouse: 'wh', namespace: 'gsc' })
    const q: ArbitrarySqlQuery = {
      ...base,
      archetype: 'arbitrary-sql',
      sql: 'SELECT count(*) AS n FROM {{queries}} WHERE site_id = ?',
      params: ['site-1'],
    }
    await exec.runArchetype(q)
    expect(svc.calls[0]).toContain('iceberg_scan(\'wh/gsc/queries\')')
    expect(svc.calls[0]).toContain('\'site-1\'')
  })

  it('rejects aux-cloud-only', async () => {
    const svc = fakeSvc([])
    const exec = createDuckDbIcebergExecutor({ svc, warehouse: 'wh', namespace: 'gsc' })
    await expect(
      exec.runArchetype({ archetype: 'aux-cloud-only', siteId: 's', dataset: 'indexing' } as any),
    ).rejects.toThrow(DuckDbIcebergError)
  })

  it('wraps a sibling RPC failure in DuckDbIcebergError', async () => {
    const svc = {
      runSQL: vi.fn(async () => {
        throw new Error('OOM in sibling')
      }),
    }
    const exec = createDuckDbIcebergExecutor({ svc, warehouse: 'wh', namespace: 'gsc' })
    await expect(exec.runSql('SELECT 1')).rejects.toThrow(/OOM in sibling/)
  })
})

describe('createDuckDbIcebergExecutor runArchetypeResult', () => {
  it('returns ok with rows on success', async () => {
    const svc = fakeSvc([{ url: 'a', query: 'b', clicks: 1 }])
    const exec = createDuckDbIcebergExecutor({ svc, warehouse: 'wh', namespace: 'gsc' })
    const res = await exec.runArchetypeResult!({
      ...base,
      archetype: 'two-dimension-detail',
      metrics: ['clicks'],
    } as TwoDimensionDetailQuery)
    expect(res.ok).toBe(true)
    if (res.ok)
      expect(res.value.rows).toEqual([{ url: 'a', query: 'b', clicks: 1 }])
  })

  it('returns err with a DuckDbIcebergError for aux-cloud-only', async () => {
    const svc = fakeSvc([])
    const exec = createDuckDbIcebergExecutor({ svc, warehouse: 'wh', namespace: 'gsc' })
    const res = await exec.runArchetypeResult!(
      { archetype: 'aux-cloud-only', siteId: 's', dataset: 'indexing' } as any,
    )
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.error).toBeInstanceOf(DuckDbIcebergError)
  })

  it('returns err with a DuckDbIcebergError on a sibling RPC failure', async () => {
    const svc = {
      runSQL: vi.fn(async () => {
        throw new Error('OOM in sibling')
      }),
    }
    const exec = createDuckDbIcebergExecutor({ svc, warehouse: 'wh', namespace: 'gsc' })
    const res = await exec.runArchetypeResult!({
      ...base,
      archetype: 'arbitrary-sql',
      sql: 'SELECT 1',
      params: [],
    } as ArbitrarySqlQuery)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(DuckDbIcebergError)
      expect(res.error.message).toMatch(/OOM in sibling/)
    }
  })
})
