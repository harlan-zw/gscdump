// Integration test: resolveComparisonSQL + buildTotalsSql + buildExtrasQueries
// over real DuckDB. Drives the resolver fragments directly through
// engine.runSQL; uses the filesystem adapter to seed parquet, then exercises
// the resolver-compiled SQL through the parquet adapter (FILES placeholder
// substitution + AS alias).

import type { BuilderState } from 'gscdump/query'
import type { Row } from '../src/index'
import type { ComparisonFilter } from '../src/resolver/types'
import type { StorageEngine, TableName } from '../src/storage'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLogicalPlan } from 'gscdump/query/plan'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '../src/adapters/duckdb-node'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '../src/adapters/filesystem'
import { decodeParquetToRows } from '../src/adapters/hyparquet'
import { enumeratePartitions } from '../src/compaction'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '../src/index'
import { buildQueryDimRecords, createQueryDimStore } from '../src/query-dim'
import { buildExtrasQueries, buildTotalsSql, resolveComparisonSQL } from '../src/resolver/compile'
import { createParquetResolverAdapter } from '../src/resolver/pg-adapter'
import { queryCanonicalVariantsRollup, rebuildRollups } from '../src/rollups'

afterAll(() => {
  resetNodeDuckDB()
})

interface ComparisonRunResult {
  rows: Row[]
  totalCount: number
  totals: Record<string, unknown>
}

// Mirrors the deleted StorageEngine.queryComparison orchestration so the
// resolver fragment keeps its DuckDB integration coverage.
async function runComparison(
  engine: StorageEngine,
  ctx: { userId: string, siteId: string, table?: TableName },
  current: BuilderState,
  previous: BuilderState,
  filter?: ComparisonFilter,
): Promise<ComparisonRunResult> {
  const adapter = createParquetResolverAdapter()
  const currentPlan = buildLogicalPlan(current, adapter.capabilities)
  const previousPlan = buildLogicalPlan(previous, adapter.capabilities)
  if (currentPlan.dataset !== previousPlan.dataset) {
    throw new Error(
      `runComparison: current (${currentPlan.dataset}) and previous (${previousPlan.dataset}) must resolve to the same table`,
    )
  }
  const table: TableName = ctx.table ?? currentPlan.dataset
  const comparison = resolveComparisonSQL(current, previous, { adapter, siteId: undefined }, filter)
  const totals = buildTotalsSql(current, { adapter, siteId: undefined })
  const startDate = currentPlan.dateRange.startDate < previousPlan.dateRange.startDate
    ? currentPlan.dateRange.startDate
    : previousPlan.dateRange.startDate
  const endDate = currentPlan.dateRange.endDate > previousPlan.dateRange.endDate
    ? currentPlan.dateRange.endDate
    : previousPlan.dateRange.endDate
  const partitions = enumeratePartitions(startDate, endDate)
  const fileSets = { FILES: { table, partitions } }
  const baseCtx = { userId: ctx.userId, siteId: ctx.siteId }
  const [main, count, totalsRow] = await Promise.all([
    engine.runSQL({ ctx: baseCtx, table, fileSets, sql: comparison.sql, params: comparison.params }),
    engine.runSQL({ ctx: baseCtx, table, fileSets, sql: comparison.countSql, params: comparison.countParams }),
    engine.runSQL({ ctx: baseCtx, table, fileSets, sql: totals.sql, params: totals.params }),
  ])
  return {
    rows: main.rows,
    totalCount: Number(count.rows[0]?.total ?? 0),
    totals: (totalsRow.rows[0] ?? {}) as Record<string, unknown>,
  }
}

async function runExtras(
  engine: StorageEngine,
  ctx: { userId: string, siteId: string, table?: TableName },
  state: BuilderState,
  queryDim?: { table: TableName, keys: string[] },
): Promise<Array<{ key: string, rows: Row[] }>> {
  const adapter = createParquetResolverAdapter()
  const extras = buildExtrasQueries(state, { adapter, siteId: undefined })
  if (extras.length === 0)
    return []
  const plan = buildLogicalPlan(state, adapter.capabilities)
  const table: TableName = ctx.table ?? plan.dataset
  const partitions = enumeratePartitions(plan.dateRange.startDate, plan.dateRange.endDate)
  const fileSets = {
    FILES: { table, partitions },
    ...(queryDim ? { QUERY_DIM: queryDim } : {}),
  }
  const baseCtx = { userId: ctx.userId, siteId: ctx.siteId }
  const results = await Promise.all(extras.map(e =>
    engine.runSQL({ ctx: baseCtx, table, fileSets, sql: e.sql, params: e.params }),
  ))
  return extras.map((e, i) => ({ key: e.key, rows: results[i]!.rows }))
}

function pageRow(url: string, date: string, clicks: number, impressions: number): Row {
  return { url, date, clicks, impressions, sum_position: impressions * 5 }
}

function pagesState(start: string, end: string, rest: Partial<BuilderState> = {}): BuilderState {
  return {
    dimensions: ['page'],
    filter: {
      _filters: [{
        dimension: 'date',
        operator: 'between',
        expression: start,
        expression2: end,
      }],
    } as any,
    ...rest,
  }
}

describe('resolveComparisonSQL (integration)', () => {
  let dir: string
  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(join(tmpdir(), 'gscdump-cmp-'))
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

  async function seedTwoWindows(engine: StorageEngine) {
    for (const day of ['2026-03-01', '2026-03-02', '2026-03-03']) {
      await engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: day },
        [
          pageRow('/a', day, 5, 50),
          pageRow('/b', day, 1, 10),
        ],
      )
    }
    for (const day of ['2026-03-08', '2026-03-09', '2026-03-10']) {
      await engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: day },
        [
          pageRow('/a', day, 10, 100),
          pageRow('/c', day, 4, 40),
        ],
      )
    }
  }

  it('joins current and previous windows with delta columns', async () => {
    const { engine } = await setup()
    await seedTwoWindows(engine)

    const result = await runComparison(
      engine,
      { userId: 'u1', siteId: 's1' },
      pagesState('2026-03-08', '2026-03-14'),
      pagesState('2026-03-01', '2026-03-07'),
    )

    const byPage = new Map(result.rows.map(r => [r.page as string, r]))
    expect(Number(byPage.get('/a')!.clicks)).toBe(30)
    expect(Number(byPage.get('/a')!.prevClicks)).toBe(15)
    expect(Number(byPage.get('/c')!.clicks)).toBe(12)
    expect(Number(byPage.get('/c')!.prevClicks)).toBe(0)
    // /b is present only in the previous window — a "lost" page. The FULL OUTER
    // JOIN surfaces it with zeroed current metrics and its prior totals.
    expect(byPage.has('/b')).toBe(true)
    expect(Number(byPage.get('/b')!.clicks)).toBe(0)
    expect(Number(byPage.get('/b')!.prevClicks)).toBe(3)
  })

  it('filter=new returns only rows missing from previous', async () => {
    const { engine } = await setup()
    await seedTwoWindows(engine)

    const result = await runComparison(
      engine,
      { userId: 'u1', siteId: 's1' },
      pagesState('2026-03-08', '2026-03-14'),
      pagesState('2026-03-01', '2026-03-07'),
      'new',
    )
    const pages = result.rows.map(r => r.page as string)
    expect(pages).toContain('/c')
    expect(pages).not.toContain('/a')
  })

  it('returns totals row independent of comparison filter', async () => {
    const { engine } = await setup()
    await seedTwoWindows(engine)

    const result = await runComparison(
      engine,
      { userId: 'u1', siteId: 's1' },
      pagesState('2026-03-08', '2026-03-14'),
      pagesState('2026-03-01', '2026-03-07'),
      'new',
    )
    expect(Number(result.totals.clicks)).toBe(42)
  })

  it('throws when current and previous resolve to different tables', async () => {
    const { engine } = await setup()
    await seedTwoWindows(engine)
    const pagesS = pagesState('2026-03-08', '2026-03-14')
    const keywordsS: BuilderState = {
      ...pagesS,
      dimensions: ['query'],
    }
    await expect(
      runComparison(engine, { userId: 'u1', siteId: 's1' }, pagesS, keywordsS),
    ).rejects.toThrow(/must resolve to the same table/)
  })
})

describe('buildExtrasQueries (integration)', () => {
  let dir: string
  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(join(tmpdir(), 'gscdump-extras-'))
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

  it('returns [] when state has no extras-eligible dimensions', async () => {
    const { engine } = await setup()
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-03-10' },
      [pageRow('/a', '2026-03-10', 1, 10)],
    )
    const result = await runExtras(
      engine,
      { userId: 'u1', siteId: 's1' },
      pagesState('2026-03-01', '2026-03-31'),
    )
    expect(result).toEqual([])
  })
})

// The overlay's correctness claim (ADR-0017): the materialised
// `query_canonical_variants` rollup must produce byte-identical extra rows to
// the live `buildExtrasQueries` window-function SQL, so `mergeExtras` consumes
// either source unchanged. Exercise BOTH against real DuckDB over the same
// seed and assert the per-canonical maps match.
describe('queryCanonicalVariantsRollup (integration)', () => {
  let dir: string
  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(join(tmpdir(), 'gscdump-canon-'))
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

  // Mirrors the CLI's RollupEngine wiring (commands/rollups.ts): runSQL passes
  // through, listPartitions derives from the live manifest.
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

  function queryRow(query: string, date: string, clicks: number, impressions: number): Row {
    return { query, date, clicks, impressions, sum_position: impressions * 5 }
  }

  function keyByJoin(rows: Array<Record<string, unknown>>) {
    return new Map(rows.map(r => [String(r.joinKey), {
      variantCount: Number(r.variantCount),
      canonicalName: r.canonicalName == null ? null : String(r.canonicalName),
      variants: r.variants == null ? null : String(r.variants),
    }]))
  }

  async function seed(engine: StorageEngine) {
    // 'foo' canonical: two variants, 'Foo' out-clicks 'foos' → canonicalName='Foo'.
    // 'bar' canonical: single variant.
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'queries', date: '2026-03-10' },
      [
        queryRow('Foo', '2026-03-10', 500, 5000),
        queryRow('foos', '2026-03-10', 100, 1000),
        queryRow('bar', '2026-03-10', 100, 1000),
      ],
    )
  }

  async function writeQueryDim(dataSource: ReturnType<typeof createFilesystemDataSource>) {
    const store = createQueryDimStore({ dataSource })
    const records = buildQueryDimRecords(['Foo', 'foos', 'bar'], {
      normalizeQuery: (query) => {
        const lower = query.toLowerCase()
        return lower === 'foos' ? 'foo' : lower
      },
      normalizerVersion: 2,
      classifyIntentCode: () => 0,
      intentVersion: 1,
    })
    await store.write({ userId: 'u1', siteId: 's1' }, records, 1_700_000_000_000)
    return { table: 'queries' as TableName, keys: [store.parquetKey({ userId: 'u1', siteId: 's1' })] }
  }

  function canonicalState(start: string, end: string): BuilderState {
    return {
      dimensions: ['queryCanonical'],
      filter: {
        _filters: [{ dimension: 'date', operator: 'between', expression: start, expression2: end }],
      } as any,
    }
  }

  it('materialises the same per-canonical extras the live query produces', async () => {
    const { engine, dataSource } = await setup()
    await seed(engine)
    const queryDim = await writeQueryDim(dataSource)

    // Live path: the window-function SQL the read path runs today.
    const liveExtras = await runExtras(engine, { userId: 'u1', siteId: 's1' }, canonicalState('2026-03-01', '2026-03-31'), queryDim)
    expect(liveExtras).toHaveLength(1)
    expect(liveExtras[0].key).toBe('canonicalExtras')
    const live = keyByJoin(liveExtras[0].rows)

    // Materialised path: build the rollup over real DuckDB, decode the parquet.
    const results = await rebuildRollups({
      engine: rollupEngine(engine),
      dataSource,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [queryCanonicalVariantsRollup],
      now: () => 1_700_000_000_000,
    })
    expect(results[0].error).toBeUndefined()
    const rolledUp = keyByJoin(await decodeParquetToRows(await dataSource.read(results[0].parquetKey!)))

    // Byte-identical grouping: same canonicals, counts, top variant, and packed
    // variant strings — so mergeExtras can't tell the two sources apart.
    expect([...rolledUp.keys()].sort()).toEqual([...live.keys()].sort())
    for (const [k, v] of live)
      expect(rolledUp.get(k)).toEqual(v)

    expect(live.get('foo')).toMatchObject({ variantCount: 2, canonicalName: 'Foo' })
    expect(live.get('bar')).toMatchObject({ variantCount: 1, canonicalName: 'bar' })
  })
})
