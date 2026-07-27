// Canonical-primary correctness: `queryCanonical` is a total derived dimension.
// Fact rows carry only raw `query`; resolver SQL joins `query_dim` and falls
// back to raw query when a dimension row is missing.

import type { BuilderState } from 'gscdump/query'
import type { Row } from '../src/index'
import type { StorageEngine, TableName } from '../src/storage'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '../src/adapters/duckdb-node'
import { createFilesystemDataSource, createFilesystemManifestStore } from '../src/adapters/filesystem'
import { enumeratePartitions } from '../src/compaction'
import { buildQueryDimRecords, createQueryDimStore } from '../src/entities'
import { createDuckDBCodec, createDuckDBExecutor, createStorageEngine } from '../src/index'
import { resolveComparisonSQL, resolveToSQLOptimized } from '../src/resolver/compile'
import { createParquetResolverAdapter } from '../src/resolver/pg-adapter'

afterAll(() => {
  resetNodeDuckDB()
})

const tenant = { userId: 'u1', siteId: 's1' }

function qRow(query: string, date: string, clicks: number, impressions: number): Row {
  return { query, date, clicks, impressions, sum_position: impressions * 5 }
}

function canonicalState(start: string, end: string): BuilderState {
  return {
    dimensions: ['queryCanonical'],
    filter: {
      _filters: [{ dimension: 'date', operator: 'between', expression: start, expression2: end }],
    } as any,
  }
}

describe('query_dim canonical integration', () => {
  let dir: string
  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(join(tmpdir(), 'gscdump-query-dim-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function setup() {
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const codec = createDuckDBCodec(factory)
    const executor = createDuckDBExecutor(factory)
    const dataSource = createFilesystemDataSource({ rootDir: dir })
    const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })
    return { engine, dataSource }
  }

  async function writeQueryDim(dataSource: ReturnType<typeof createFilesystemDataSource>, queries = ['Foo', 'foos', 'bar', 'baz']) {
    const store = createQueryDimStore({ dataSource })
    const records = buildQueryDimRecords(queries, {
      normalizeQuery: (query) => {
        const lower = query.toLowerCase()
        return lower === 'foos' ? 'foo' : lower
      },
      normalizerVersion: 2,
      classifyIntentCode: () => 0,
      intentVersion: 1,
    })
    await store.write(tenant, records, 1_700_000_000_000)
    return { table: 'queries' as TableName, keys: [store.parquetKey(tenant)] }
  }

  async function runGrouped(engine: StorageEngine, state: BuilderState, queryDim: Awaited<ReturnType<typeof writeQueryDim>>) {
    const adapter = createParquetResolverAdapter()
    const { sql, params } = resolveToSQLOptimized(state, { adapter, siteId: undefined })
    const partitions = enumeratePartitions('2026-03-01', '2026-03-31')
    const res = await engine.runSQL({
      ctx: tenant,
      table: 'queries' as TableName,
      fileSets: { FILES: { table: 'queries' as TableName, partitions }, QUERY_DIM: queryDim },
      sql,
      params,
    })
    return res.rows
  }

  it('groups queryCanonical from query_dim without fact-table canonical columns', async () => {
    const { engine, dataSource } = await setup()
    await engine.writeDay(
      { ...tenant, table: 'queries', date: '2026-03-10' },
      [
        qRow('Foo', '2026-03-10', 10, 100),
        qRow('foos', '2026-03-10', 5, 50),
        qRow('bar', '2026-03-10', 7, 70),
        qRow('baz', '2026-03-10', 3, 30),
      ],
    )
    const queryDim = await writeQueryDim(dataSource)

    const rows = await runGrouped(engine, canonicalState('2026-03-01', '2026-03-31'), queryDim)
    const byKey = new Map(rows.map(r => [r.queryCanonical, Number(r.clicks)]))
    expect([...byKey.keys()].sort()).toEqual(['bar', 'baz', 'foo'])
    expect(byKey.get('foo')).toBe(15)
    expect(byKey.get('bar')).toBe(7)
    expect(byKey.get('baz')).toBe(3)
    expect([...byKey.keys()]).not.toContain(null)
    expect([...byKey.keys()]).not.toContain('')
  })

  it('falls back to raw query when a query_dim row is missing', async () => {
    const { engine, dataSource } = await setup()
    await engine.writeDay(
      { ...tenant, table: 'queries', date: '2026-03-10' },
      [qRow('unmapped', '2026-03-10', 6, 60)],
    )
    const queryDim = await writeQueryDim(dataSource, ['Foo'])

    const rows = await runGrouped(engine, canonicalState('2026-03-01', '2026-03-31'), queryDim)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.queryCanonical).toBe('unmapped')
    expect(Number(rows[0]!.clicks)).toBe(6)
  })

  it('filters queryCanonical through the query_dim expression', async () => {
    const { engine, dataSource } = await setup()
    await engine.writeDay(
      { ...tenant, table: 'queries', date: '2026-03-10' },
      [
        qRow('foo', '2026-03-10', 10, 100),
        qRow('bar', '2026-03-10', 7, 70),
        qRow('baz', '2026-03-10', 3, 30),
      ],
    )
    const queryDim = await writeQueryDim(dataSource, ['foo', 'bar', 'baz'])
    const filtered: BuilderState = {
      dimensions: ['queryCanonical'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'queryCanonical', operator: 'equals', expression: 'bar' },
        ],
      } as any,
    }

    const rows = await runGrouped(engine, filtered, queryDim)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.queryCanonical).toBe('bar')
    expect(Number(rows[0]!.clicks)).toBe(7)
  })

  async function runComparison(engine: StorageEngine, queryDim: Awaited<ReturnType<typeof writeQueryDim>>) {
    const adapter = createParquetResolverAdapter()
    const current = canonicalState('2026-03-08', '2026-03-14')
    const previous = canonicalState('2026-03-01', '2026-03-07')
    const cmp = resolveComparisonSQL(current, previous, { adapter, siteId: undefined })
    const partitions = enumeratePartitions('2026-03-01', '2026-03-14')
    const res = await engine.runSQL({
      ctx: tenant,
      table: 'queries' as TableName,
      fileSets: { FILES: { table: 'queries' as TableName, partitions }, QUERY_DIM: queryDim },
      sql: cmp.sql,
      params: cmp.params,
    })
    return res.rows
  }

  it('gaining/losing matches the same canonical query across windows', async () => {
    const { engine, dataSource } = await setup()
    await engine.writeDay(
      { ...tenant, table: 'queries', date: '2026-03-03' },
      [qRow('bar', '2026-03-03', 4, 40)],
    )
    await engine.writeDay(
      { ...tenant, table: 'queries', date: '2026-03-10' },
      [qRow('bar', '2026-03-10', 9, 90)],
    )
    const queryDim = await writeQueryDim(dataSource, ['bar'])

    const rows = await runComparison(engine, queryDim)
    const barRows = rows.filter(r => r.queryCanonical === 'bar')
    expect(barRows.length).toBe(1)
    expect(Number(barRows[0]!.clicks)).toBe(9)
    expect(Number(barRows[0]!.prevClicks)).toBe(4)
  })
})
