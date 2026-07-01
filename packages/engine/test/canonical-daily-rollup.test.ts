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
import { decodeParquetToRows } from '../src/adapters/hyparquet'
import { createDuckDBCodec, createDuckDBExecutor, createStorageEngine } from '../src/index'
import { buildQueryDimRecords, createQueryDimStore } from '../src/query-dim'
import { canonicalRollupCovers } from '../src/resolver/canonical-source'
import { createParquetResolverAdapter } from '../src/resolver/pg-adapter'
import { runComparisonQuery, runOptimizedQuery } from '../src/resolver/run-query'
import { queryCanonicalDailyRollup, rebuildCanonicalDailyResumable, rebuildRollups, rollupKey } from '../src/rollups'

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

  it('covers a canonical-only query filtered by queryCanonical', () => {
    const state: BuilderState = {
      dimensions: ['queryCanonical'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'queryCanonical', operator: 'equals', expression: 'bar' },
        ],
      } as any,
    }
    expect(canonicalRollupCovers(state, caps)).toBe(true)
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

  function qRow(query: string, date: string, clicks: number, impressions: number): Row {
    return { query, date, clicks, impressions, sum_position: impressions * 5 }
  }

  async function seed(engine: StorageEngine) {
    // 'foo' has two variants across two days. Canonical grouping is supplied
    // by query_dim, not by a fact-table `query_canonical` column.
    await engine.writeDay({ userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-03' }, [
      qRow('Foo', '2026-03-03', 10, 100),
      qRow('foos', '2026-03-03', 5, 50),
      qRow('bar', '2026-03-03', 7, 70),
    ])
    await engine.writeDay({ userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-10' }, [
      qRow('Foo', '2026-03-10', 4, 40),
      qRow('baz', '2026-03-10', 3, 30),
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

  async function writeDefaultQueryDim(dataSource: any, normalizerVersion = 2) {
    const store = createQueryDimStore({ dataSource })
    const recs = buildQueryDimRecords(['Foo', 'foos', 'bar', 'baz'], {
      normalizeQuery: (q) => {
        const lower = q.toLowerCase()
        return lower === 'foos' ? 'foo' : lower
      },
      normalizerVersion,
      classifyIntentCode: () => 0,
      intentVersion: 1,
    })
    await store.write({ userId: 'u1', siteId: 's1' }, recs, 1_700_000_000_000)
    return {
      keys: [store.parquetKey({ userId: 'u1', siteId: 's1' })],
      normalizerVersion,
      intentVersion: 1,
    }
  }

  function canonicalSource(key: string, queryDim: Awaited<ReturnType<typeof writeDefaultQueryDim>>) {
    return {
      keys: [key],
      queryDim,
    }
  }

  const ctx = { userId: 'u1', siteId: 's1', table: 'queries' as TableName }

  function byCanonical(rows: Array<Record<string, unknown>>) {
    return new Map(rows.map(r => [String(r.queryCanonical), {
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
    }]))
  }

  it('derives canonical from the query dimension when present (not the stored column)', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    // Build a dimension that maps the foo-variants to a DIFFERENT canonical,
    // simulating an improved/newer normalizer. The rollup must reflect this
    // without re-ingesting the facts.
    const store = createQueryDimStore({ dataSource })
    const recs = buildQueryDimRecords(['Foo', 'foos', 'bar', 'baz'], {
      normalizeQuery: q => (q.toLowerCase() === 'foo' || q.toLowerCase() === 'foos' ? 'foo_v2' : q.toLowerCase()),
      normalizerVersion: 3,
      classifyIntentCode: () => 0,
      intentVersion: 1,
    })
    await store.write({ userId: 'u1', siteId: 's1' }, recs, 1_700_000_000_000)

    const key = await buildDaily(engine, dataSource)
    const rows = await decodeParquetToRows(await dataSource.read(key))
    // Rollup is date-grained, so sum a canonical's clicks across its date rows.
    const sumByKey = new Map<string, number>()
    for (const r of rows)
      sumByKey.set(String(r.query_canonical), (sumByKey.get(String(r.query_canonical)) ?? 0) + Number(r.clicks))
    // Grouped under the dimension's canonical, summing both foo variants.
    expect(sumByKey.has('foo_v2')).toBe(true)
    expect(sumByKey.has('foo')).toBe(false)
    expect(sumByKey.get('foo_v2')).toBe(19) // 10+5 (Mar 3) + 4 (Mar 10)
  })

  it('top: rollup-served results equal live raw aggregation (with fallback)', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeDefaultQueryDim(dataSource)
    const key = await buildDaily(engine, dataSource)
    const state = canonicalState('2026-03-01', '2026-03-31')
    const range = { startDate: '2026-03-01', endDate: '2026-03-31' }

    const live = await runOptimizedQuery(engine.runSQL, ctx, state, range, {
      queryDim,
      primarySourceFallback: 'raw',
    })
    const rolled = await runOptimizedQuery(engine.runSQL, ctx, state, range, {
      canonicalSource: canonicalSource(key, queryDim),
      primarySourceFallback: 'raw',
    })

    const liveMap = byCanonical(live.rows)
    const rolledMap = byCanonical(rolled.rows)
    expect([...rolledMap.keys()].sort()).toEqual([...liveMap.keys()].sort())
    for (const [k, v] of liveMap)
      expect(rolledMap.get(k)).toEqual(v)
    // 'foo' sums both variants across both days; bar/baz folded to themselves.
    expect(liveMap.get('foo')).toEqual({ clicks: 19, impressions: 190 })
    expect(rolledMap.get('bar')).toEqual({ clicks: 7, impressions: 70 })
    expect(live.source).toMatchObject({
      kind: 'raw-partitions',
      fallback: { kind: 'canonical-source-missing' },
      fallbacks: [
        { kind: 'canonical-source-missing' },
        { kind: 'primary-source-missing' },
      ],
    })
    expect(rolled.source).toEqual({ kind: 'canonical-rollup' })
    expect(rolled.extraSource).toMatchObject({ kind: 'raw-partitions', fallback: { kind: 'primary-source-missing' } })
  })

  it('top: queryCanonical filters use fallback on live and match the rollup', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeDefaultQueryDim(dataSource)
    const key = await buildDaily(engine, dataSource)
    const filtered: BuilderState = {
      dimensions: ['queryCanonical'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'queryCanonical', operator: 'equals', expression: 'bar' },
        ],
      } as any,
    }
    const range = { startDate: '2026-03-01', endDate: '2026-03-31' }

    const live = await runOptimizedQuery(engine.runSQL, ctx, filtered, range, {
      queryDim,
      primarySourceFallback: 'raw',
    })
    const rolled = await runOptimizedQuery(engine.runSQL, ctx, filtered, range, {
      canonicalSource: canonicalSource(key, queryDim),
      primarySourceFallback: 'raw',
    })

    const liveMap = byCanonical(live.rows)
    const rolledMap = byCanonical(rolled.rows)
    expect([...liveMap.keys()]).toEqual(['bar'])
    expect([...rolledMap.keys()]).toEqual(['bar'])
    expect(rolledMap.get('bar')).toEqual(liveMap.get('bar'))
    expect(liveMap.get('bar')).toEqual({ clicks: 7, impressions: 70 })
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
      primarySourceFallback: 'raw',
    })
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.rows.some(r => r.query === 'Foo')).toBe(true)
  })

  it('uses a canonical rollup without the legacy fallback flag', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeDefaultQueryDim(dataSource)
    const key = await buildDaily(engine, dataSource)
    const res = await runOptimizedQuery(engine.runSQL, ctx, canonicalState('2026-03-01', '2026-03-31'), { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      canonicalSource: canonicalSource(key, queryDim),
      primarySourceFallback: 'raw',
    })
    expect(res.source).toEqual({ kind: 'canonical-rollup' })
  })

  it('fails a window newer than the rollup coverage by default (no silent undercount)', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeDefaultQueryDim(dataSource)
    const key = await buildDaily(engine, dataSource)
    // Window ends 2026-03-31 but the rollup only covers through 2026-03-10.
    await expect(runOptimizedQuery(engine.runSQL, ctx, canonicalState('2026-03-01', '2026-03-31'), { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      canonicalSource: { ...canonicalSource(key, queryDim), coversThrough: '2026-03-10' },
    })).rejects.toMatchObject({
      fallback: { kind: 'primary-source-missing' },
    })
  })

  it('allows stale coverage only through explicit raw fallback', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeDefaultQueryDim(dataSource)
    const key = await buildDaily(engine, dataSource)
    const res = await runOptimizedQuery(engine.runSQL, ctx, canonicalState('2026-03-01', '2026-03-31'), { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      canonicalSource: { ...canonicalSource(key, queryDim), coversThrough: '2026-03-10' },
      primarySourceFallback: 'raw',
    })
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.source).toMatchObject({ kind: 'raw-partitions', fallback: { kind: 'canonical-source-stale-coverage' } })
  })

  it('uses raw facts through query_dim when canonicalSource is missing', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeDefaultQueryDim(dataSource)
    const res = await runOptimizedQuery(engine.runSQL, ctx, canonicalState('2026-03-01', '2026-03-31'), { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      queryDim,
      primarySourceFallback: 'raw',
    })
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.source).toMatchObject({ kind: 'raw-partitions', fallback: { kind: 'canonical-source-missing' } })
  })

  it('fails canonical reads when query dimension metadata is missing from the source', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    await writeDefaultQueryDim(dataSource)
    const key = await buildDaily(engine, dataSource)
    await expect(runOptimizedQuery(engine.runSQL, ctx, canonicalState('2026-03-01', '2026-03-31'), { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      canonicalSource: { keys: [key] },
    })).rejects.toMatchObject({
      fallback: { kind: 'query-dim-missing' },
    })
  })

  it('fails canonical reads when query dimension version is stale', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeDefaultQueryDim(dataSource, 2)
    const key = await buildDaily(engine, dataSource)
    await expect(runOptimizedQuery(engine.runSQL, ctx, canonicalState('2026-03-01', '2026-03-31'), { startDate: '2026-03-01', endDate: '2026-03-31' }, {
      canonicalSource: canonicalSource(key, queryDim),
      canonicalRequirements: { normalizerVersion: 3 },
    })).rejects.toMatchObject({
      fallback: { kind: 'query-dim-stale-version' },
    })
  })

  it('resumable build across page + window boundaries equals the one-shot rollup', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    await writeDefaultQueryDim(dataSource)

    // One-shot reference (single parquet).
    const refKey = await buildDaily(engine, dataSource)
    const sumByCanonical = (rows: Row[]) => {
      const m = new Map<string, { clicks: number, impressions: number }>()
      for (const r of rows) {
        const k = String(r.query_canonical)
        const prev = m.get(k) ?? { clicks: 0, impressions: 0 }
        m.set(k, { clicks: prev.clicks + Number(r.clicks), impressions: prev.impressions + Number(r.impressions) })
      }
      return m
    }
    const refMap = sumByCanonical(await decodeParquetToRows(await dataSource.read(refKey)))

    // Resumable: pageRows=1 + an already-passed deadline forces a pause after EVERY
    // page, so the build fragments across both mid-window (pageOffset) and window
    // (windowOffset) boundaries — the intra-window resume path under test.
    const rCtx = { userId: 'u1', siteId: 's1' }
    const builtAt = 1_700_000_111_111
    let windowOffset = 0
    let pageOffset = 0
    let done = false
    let iters = 0
    let sawMidWindowPause = false
    while (!done) {
      const r = await rebuildCanonicalDailyResumable({
        engine: rollupEngine(engine) as any,
        ctx: rCtx,
        dataSource,
        builtAt,
        windowOffset,
        pageOffset,
        pageRows: 1,
        deadlineMs: Date.now() - 1,
      })
      if (!r.done && r.nextWindowOffset === windowOffset && r.nextPageOffset > pageOffset)
        sawMidWindowPause = true
      done = r.done
      windowOffset = r.nextWindowOffset
      pageOffset = r.nextPageOffset
      if (++iters > 500)
        throw new Error('resumable build did not converge')
    }
    // The fragmentation actually exercised the mid-window resume path.
    expect(sawMidWindowPause).toBe(true)

    // Read the published multi-file envelope and union every part.
    const envKey = rollupKey(rCtx, 'query_canonical_daily', builtAt)
    const envelope = JSON.parse(new TextDecoder().decode(await dataSource.read(envKey)))
    const partKeys: string[] = envelope.payload.parquetKeys
    expect(partKeys.length).toBeGreaterThan(1) // genuinely fragmented into parts
    const unioned: Row[] = []
    for (const k of partKeys)
      unioned.push(...await decodeParquetToRows(await dataSource.read(k)))
    const gotMap = sumByCanonical(unioned)

    expect([...gotMap.keys()].sort()).toEqual([...refMap.keys()].sort())
    for (const [k, v] of refMap)
      expect(gotMap.get(k)).toEqual(v)
    // Sanity: 'foo' still sums both variants across both days.
    expect(gotMap.get('foo')).toEqual({ clicks: 19, impressions: 190 })
  })

  it('gaining/losing: rollup-served comparison equals live raw comparison', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeDefaultQueryDim(dataSource)
    const key = await buildDaily(engine, dataSource)
    const current = canonicalState('2026-03-08', '2026-03-14')
    const previous = canonicalState('2026-03-01', '2026-03-07')
    const windows = { current: { startDate: '2026-03-08', endDate: '2026-03-14' }, previous: { startDate: '2026-03-01', endDate: '2026-03-07' } }

    const live = await runComparisonQuery(engine.runSQL, ctx, current, previous, windows, undefined, {
      queryDim,
      primarySourceFallback: 'raw',
    })
    const rolled = await runComparisonQuery(engine.runSQL, ctx, current, previous, windows, undefined, {
      canonicalSource: canonicalSource(key, queryDim),
    })

    const liveFoo = live.rows.find(r => r.queryCanonical === 'foo')
    const rolledFoo = rolled.rows.find(r => r.queryCanonical === 'foo')
    // foo: current (Mar 10) clicks 4, previous (Mar 03) clicks 15.
    expect(Number(liveFoo!.clicks)).toBe(4)
    expect(Number(liveFoo!.prevClicks)).toBe(15)
    expect(rolledFoo).toEqual(liveFoo)
  })
})
