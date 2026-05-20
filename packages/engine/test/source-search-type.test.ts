import type { Analyzer } from '../src/analyzer'
import type { StorageEngine, TenantCtx } from '../src/storage'
import { describe, expect, it, vi } from 'vitest'
import { createAnalyzerRegistry } from '../src/analyzer'
import { runAnalyzerWithEngine } from '../src/source'

const CTX: TenantCtx = { userId: 'u1', siteId: 's1' }

function fakeEngine(overrides: Partial<StorageEngine>): StorageEngine {
  return overrides as StorageEngine
}

const rowAnalyzer = {
  id: 'data-query',
  requires: [],
  build: () => ({
    kind: 'rows',
    queries: {
      current: {
        state: { dimensions: ['page'] },
      },
    },
  }),
  reduce: rows => ({
    results: Array.isArray(rows) ? rows : rows.current,
    meta: {},
  }),
} satisfies Analyzer

const sqlAnalyzer = {
  id: 'data-query',
  requires: ['executeSql', 'fileSets'],
  build: () => ({
    kind: 'sql',
    sql: 'SELECT * FROM read_parquet({{FILES}}, union_by_name = true)',
    params: [],
    current: {
      table: 'pages',
      partitions: ['daily/2026-05-01'],
    },
  }),
  reduce: rows => ({
    results: rows,
    meta: {},
  }),
} satisfies Analyzer

describe('runAnalyzerWithEngine searchType scoping', () => {
  it('defaults omitted searchType to web for row-query analyzers', async () => {
    const query = vi.fn(async () => ({
      rows: [{ page: '/a' }],
      sql: '',
      objectKeys: [],
    }))
    const registry = createAnalyzerRegistry({ rows: [rowAnalyzer] })

    await runAnalyzerWithEngine(
      { engine: fakeEngine({ query }) },
      CTX,
      { type: 'data-query' },
      registry,
    )

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ ...CTX, searchType: 'web' }),
      expect.objectContaining({ dimensions: ['page'] }),
    )
  })

  it('forwards explicit searchType to SQL analyzers', async () => {
    const runSQL = vi.fn(async () => ({
      rows: [{ ok: true }],
      sql: 'SELECT 1',
      objectKeys: [],
    }))
    const registry = createAnalyzerRegistry({ sql: [sqlAnalyzer] })

    await runAnalyzerWithEngine(
      { engine: fakeEngine({ runSQL }) },
      CTX,
      { type: 'data-query', searchType: 'discover' },
      registry,
    )

    expect(runSQL).toHaveBeenCalledWith(expect.objectContaining({
      ctx: CTX,
      searchType: 'discover',
      table: 'pages',
    }))
  })
})
