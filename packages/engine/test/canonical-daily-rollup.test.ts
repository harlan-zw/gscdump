// Gap 2 (ADR-0018): the canonical-grained `query_canonical_daily` rollup must
// (a) only be used for queries it actually covers, and (b) return results
// identical to live raw aggregation for both top and gaining/losing — metrics
// are additive, so summing per-date sums over a window is exact.

import type { BuilderState } from 'gscdump/query'
import type { Row } from '../src/index'
import type { StorageEngine, TableName } from '../src/storage'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '../src/adapters/duckdb-node'
import { createFilesystemDataSource, createFilesystemManifestStore } from '../src/adapters/filesystem'
import { createDuckDBCodec, createDuckDBExecutor, createStorageEngine } from '../src/index'
import { canonicalRollupCovers } from '../src/resolver/canonical-source'
import { createParquetResolverAdapter } from '../src/resolver/pg-adapter'
import { runComparisonQuery, runOptimizedQuery } from '../src/resolver/run-query'
import { queryCanonicalDailyRollup, rebuildRollups } from '../src/rollups'

afterAll(() => {
  resetNodeDuckDB()
})

const caps = createParquetResolverAdapter().capabilities

function canonicalState(start: string, end: string, extra: Partial<BuilderState> = {}): BuilderState {
  return {
    dimensions: ['queryCanonical'],
    filter: { _filters: [{ dimension: 'date', operator: 'between', expression: start, expression2: end }] } as any,
    ...extra,
  }
}

describe('canonicalRollupCovers (eligibility gate)', () => {
  it('covers a canonical-only query filtered by date', () => {
    expect(canonicalRollupCovers(canonicalState('2026-03-01', '2026-03-31'), caps)).toBe(true)
  })

  it('rejects grouping by the raw query', () => {
    expect(canonicalRollupCovers({ ...canonicalState('2026-03-01', '2026-03-31'), dimensions: ['query'] }, caps)).toBe(false)
  })

  it('rejects a raw-query filter (needs the dropped `query` column)', () => {
    const state = canonicalState('2026-03-01', '2026-03-31')
    const withQueryFilter: BuilderState = {
      ...state,
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'query', operator: 'contains', expression: 'seo' },
        ],
      } as any,
    }
    expect(canonicalRollupCovers(withQueryFilter, caps)).toBe(false)
  })

  it('rejects a page dimension (different dataset)', () => {
    expect(canonicalRollupCovers({ ...canonicalState('2026-03-01', '2026-03-31'), dimensions: ['page', 'queryCanonical'] }, caps)).toBe(false)
  })
})

describe('query_canonical_daily rollup (integration)', () => {
  let dir: string
  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(join(tmpdir(), 'gscdump-canondaily-'))
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

  function rollupEngine(engine: StorageEngine) {
    return {
      runSQL: (opts: Parameters<StorageEngine['runSQL']>[0]) => engine.runSQL(opts),
      async listPartitions({ ctx, table, searchType }: { ctx: { userId: string, siteId?: string }, table: TableName, searchType?: string }) {
        const entries = await engine.listLive({
          userId: ctx.userId,
          ...(ctx.siteId !== undefined ? { siteId: ctx.siteId } : {}),
          table,
          ...(searchType !== undefined ? { searchType: searchType as any } : {}),
        })
        return entries.map(e => ({ partition: e.partition, bytes: e.bytes }))
      },
    }
  }

  function qRow(query: string, canonical: string | null, date: string, clicks: number, impressions: number): Row {
    return { query, query_canonical: canonical, date, clicks, impressions, sum_position: impressions * 5 }
  }

  async function seed(engine: StorageEngine) {
    // 'foo' has two variants across two days; bar (null) and baz ('') exercise
    // the null-free COALESCE the rollup is built with.
    await engine.writeDay({ userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-03' }, [
      qRow('Foo', 'foo', '2026-03-03', 10, 100),
      qRow('foos', 'foo', '2026-03-03', 5, 50),
      qRow('bar', null, '2026-03-03', 7, 70),
    ])
    await engine.writeDay({ userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-10' }, [
      qRow('Foo', 'foo', '2026-03-10', 4, 40),
      qRow('baz', '', '2026-03-10', 3, 30),
    ])
  }

  async function buildDaily(engine: StorageEngine, dataSource: any): Promise<string> {
    const results = await rebuildRollups({
      engine: rollupEngine(engine),
      dataSource,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [queryCanonicalDailyRollup],
      now: () => 1_700_000_000_000,
    })
    expect(results[0].error).toBeUndefined()
    return results[0].parquetKey!
  }

  const ctx = { userId: 'u1', siteId: 's1', table: 'queries' as TableName }

  function byCanonical(rows: Array<Record<string, unknown>>) {
    return new Map(rows.map(r => [String(r.queryCanonical), {
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
    }]))
  }

  it('top: rollup-served results equal live raw aggregation (with fallback)', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const key = await buildDaily(engine, dataSource)
    const state = canonicalState('2026-03-01', '2026-03-31')
    const range = { startDate: '2026-03-01', endDate: '2026-03-31' }

    const live = await runOptimizedQuery(engine.runSQL, ctx, state, range, { canonicalFallback: true })
    const rolled = await runOptimizedQuery(engine.runSQL, ctx, state, range, { canonicalSource: { keys: [key] }, canonicalFallback: true })

    const liveMap = byCanonical(live.rows)
    const rolledMap = byCanonical(rolled.rows)
    expect([...rolledMap.keys()].sort()).toEqual([...liveMap.keys()].sort())
    for (const [k, v] of liveMap)
      expect(rolledMap.get(k)).toEqual(v)
    // 'foo' sums both variants across both days; bar/baz folded to themselves.
    expect(liveMap.get('foo')).toEqual({ clicks: 19, impressions: 190 })
    expect(rolledMap.get('bar')).toEqual({ clicks: 7, impressions: 70 })
  })

  it('ignores canonicalSource (live path) for an ineligible query — never wrong data', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    await buildDaily(engine, dataSource)
    // Group by raw query → NOT coverable. A bogus key would error if used; the
    // gate must drop it and read raw partitions instead.
    const rawState: BuilderState = { ...canonicalState('2026-03-01', '2026-03-31'), dimensions: ['query'] }
    const res = await runOptimizedQuery(engine.runSQL, ctx, rawState, { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      canonicalSource: { keys: ['u_u1/s1/rollups/DOES_NOT_EXIST.parquet'] },
    })
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.rows.some(r => r.query === 'Foo')).toBe(true)
  })

  it('requires canonicalFallback opt-in — coalesced rollup not served to a legacy caller', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    await buildDaily(engine, dataSource)
    // Eligible query + a BOGUS key, but no fallback opt-in. The rollup carries
    // COALESCE semantics, so the gate must refuse it (bogus key would error if
    // used) and serve the live legacy path instead.
    const res = await runOptimizedQuery(engine.runSQL, ctx, canonicalState('2026-03-01', '2026-03-31'), { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      canonicalSource: { keys: ['u_u1/s1/rollups/DOES_NOT_EXIST.parquet'] },
    })
    expect(res.rows.length).toBeGreaterThan(0)
  })

  it('declines a window newer than the rollup coverage (no silent undercount)', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    await buildDaily(engine, dataSource)
    // Window ends 2026-03-31 but the rollup only covers through 2026-03-10 → the
    // staleness guard falls back to live (bogus key proves the rollup is unused).
    const res = await runOptimizedQuery(engine.runSQL, ctx, canonicalState('2026-03-01', '2026-03-31'), { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      canonicalFallback: true,
      canonicalSource: { keys: ['u_u1/s1/rollups/DOES_NOT_EXIST.parquet'], coversThrough: '2026-03-10' },
    })
    expect(res.rows.length).toBeGreaterThan(0)
  })

  it('gaining/losing: rollup-served comparison equals live raw comparison', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const key = await buildDaily(engine, dataSource)
    const current = canonicalState('2026-03-08', '2026-03-14')
    const previous = canonicalState('2026-03-01', '2026-03-07')
    const windows = { current: { startDate: '2026-03-08', endDate: '2026-03-14' }, previous: { startDate: '2026-03-01', endDate: '2026-03-07' } }

    const live = await runComparisonQuery(engine.runSQL, ctx, current, previous, windows, undefined, { canonicalFallback: true })
    const rolled = await runComparisonQuery(engine.runSQL, ctx, current, previous, windows, undefined, { canonicalSource: { keys: [key] }, canonicalFallback: true })

    const liveFoo = live.rows.find(r => r.queryCanonical === 'foo')
    const rolledFoo = rolled.rows.find(r => r.queryCanonical === 'foo')
    // foo: current (Mar 10) clicks 4, previous (Mar 03) clicks 15.
    expect(Number(liveFoo!.clicks)).toBe(4)
    expect(Number(liveFoo!.prevClicks)).toBe(15)
    expect(rolledFoo).toEqual(liveFoo)
  })
})
