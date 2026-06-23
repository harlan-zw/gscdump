// Gap 1 correctness (ADR-0018): canonical-primary lookups must treat
// `queryCanonical` as a TOTAL key. The opt-in `canonicalFallback` folds
// NULL/'' canonical back to the raw query so:
//  - top: no NULL/'' super-bucket polluting results;
//  - gaining/losing: null-canonical keywords match across windows instead of
//    double-counting as both new + lost (NULL = NULL is UNKNOWN).
// Exercised over real DuckDB. Legacy (flag off) behaviour is asserted too.

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
import { createDuckDBCodec, createDuckDBExecutor, createStorageEngine } from '../src/index'
import { resolveComparisonSQL, resolveToSQLOptimized } from '../src/resolver/compile'
import { createParquetResolverAdapter } from '../src/resolver/pg-adapter'

afterAll(() => {
  resetNodeDuckDB()
})

function qRow(query: string, canonical: string | null, date: string, clicks: number, impressions: number): Row {
  return { query, query_canonical: canonical, date, clicks, impressions, sum_position: impressions * 5 }
}

function canonicalState(start: string, end: string): BuilderState {
  return {
    dimensions: ['queryCanonical'],
    filter: {
      _filters: [{ dimension: 'date', operator: 'between', expression: start, expression2: end }],
    } as any,
  }
}

describe('canonicalFallback (integration)', () => {
  let dir: string
  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(join(tmpdir(), 'gscdump-canonfb-'))
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
    return { engine }
  }

  async function runGrouped(engine: StorageEngine, state: BuilderState, canonicalFallback: boolean) {
    const adapter = createParquetResolverAdapter({ canonicalFallback })
    const { sql, params } = resolveToSQLOptimized(state, { adapter, siteId: undefined })
    const partitions = enumeratePartitions('2026-03-01', '2026-03-31')
    const res = await engine.runSQL({
      ctx: { userId: 'u1', siteId: 's1' },
      table: 'queries' as TableName,
      fileSets: { FILES: { table: 'queries' as TableName, partitions } },
      sql,
      params,
    })
    return res.rows
  }

  it('legacy (flag off) leaks NULL/empty canonical buckets into top results', async () => {
    const { engine } = await setup()
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-10' },
      [
        qRow('Foo', 'foo', '2026-03-10', 10, 100),
        qRow('foos', 'foo', '2026-03-10', 5, 50),
        qRow('bar', null, '2026-03-10', 7, 70), // no normalizer ran
        qRow('baz', '', '2026-03-10', 3, 30), // fully-stripped → empty canonical
      ],
    )
    const rows = await runGrouped(engine, canonicalState('2026-03-01', '2026-03-31'), false)
    const keys = rows.map(r => r.queryCanonical)
    // 'foo' aggregates its two variants; bar/baz surface as degenerate NULL/''
    // buckets rather than themselves.
    expect(keys).toContain('foo')
    expect(keys.some(k => k === null || k === '')).toBe(true)
    expect(keys).not.toContain('bar')
  })

  it('fallback (flag on) folds NULL/empty canonical to the raw query — no degenerate buckets', async () => {
    const { engine } = await setup()
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-10' },
      [
        qRow('Foo', 'foo', '2026-03-10', 10, 100),
        qRow('foos', 'foo', '2026-03-10', 5, 50),
        qRow('bar', null, '2026-03-10', 7, 70),
        qRow('baz', '', '2026-03-10', 3, 30),
      ],
    )
    const rows = await runGrouped(engine, canonicalState('2026-03-01', '2026-03-31'), true)
    const byKey = new Map(rows.map(r => [r.queryCanonical, Number(r.clicks)]))
    expect([...byKey.keys()].sort()).toEqual(['bar', 'baz', 'foo'])
    expect(byKey.get('foo')).toBe(15) // both variants still aggregate
    expect(byKey.get('bar')).toBe(7) // folded to itself, not a NULL bucket
    expect(byKey.get('baz')).toBe(3)
    expect([...byKey.keys()]).not.toContain(null)
    expect([...byKey.keys()]).not.toContain('')
  })

  it('fallback (flag on) also folds queryCanonical filters to the raw query', async () => {
    const { engine } = await setup()
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-10' },
      [
        qRow('foo', 'foo', '2026-03-10', 10, 100),
        qRow('bar', null, '2026-03-10', 7, 70),
        qRow('baz', '', '2026-03-10', 3, 30),
      ],
    )
    const filtered: BuilderState = {
      dimensions: ['queryCanonical'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'queryCanonical', operator: 'equals', expression: 'bar' },
        ],
      } as any,
    }

    const rows = await runGrouped(engine, filtered, true)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.queryCanonical).toBe('bar')
    expect(Number(rows[0]!.clicks)).toBe(7)
  })

  async function runComparison(engine: StorageEngine, canonicalFallback: boolean) {
    const adapter = createParquetResolverAdapter({ canonicalFallback })
    const current = canonicalState('2026-03-08', '2026-03-14')
    const previous = canonicalState('2026-03-01', '2026-03-07')
    const cmp = resolveComparisonSQL(current, previous, { adapter, siteId: undefined })
    const partitions = enumeratePartitions('2026-03-01', '2026-03-14')
    const res = await engine.runSQL({
      ctx: { userId: 'u1', siteId: 's1' },
      table: 'queries' as TableName,
      fileSets: { FILES: { table: 'queries' as TableName, partitions } },
      sql: cmp.sql,
      params: cmp.params,
    })
    return res.rows
  }

  it('gaining/losing: null-canonical keyword double-counts under legacy, matches under fallback', async () => {
    const { engine } = await setup()
    // Same null-canonical keyword present in BOTH windows.
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-03' },
      [qRow('bar', null, '2026-03-03', 4, 40)],
    )
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-10' },
      [qRow('bar', null, '2026-03-10', 9, 90)],
    )

    // Legacy: NULL = NULL is UNKNOWN, so the FULL OUTER JOIN can't match the two
    // NULL groups → 'bar' appears twice (an unmatched current row + unmatched
    // previous row): a phantom new + phantom lost.
    const legacy = await runComparison(engine, false)
    const legacyNullRows = legacy.filter(r => r.queryCanonical === null)
    expect(legacyNullRows.length).toBe(2)

    // Fallback: both fold to 'bar' → one matched row carrying current + previous.
    const fixed = await runComparison(engine, true)
    const barRows = fixed.filter(r => r.queryCanonical === 'bar')
    expect(barRows.length).toBe(1)
    expect(Number(barRows[0]!.clicks)).toBe(9)
    expect(Number(barRows[0]!.prevClicks)).toBe(4)
  })
})
