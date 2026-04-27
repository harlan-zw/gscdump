// Integration test: queryComparison + queryExtras over real DuckDB. Uses the
// filesystem adapter to seed parquet, then exercises the resolver-compiled
// SQL through the parquet adapter (FILES placeholder substitution + AS alias).

import type { BuilderState } from 'gscdump/query'
import type { Row } from '../src/index'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '../src/adapters/duckdb-node'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '../src/adapters/filesystem'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '../src/index'

afterAll(() => {
  resetNodeDuckDB()
})

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

describe('engine.queryComparison', () => {
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

  async function seedTwoWindows(engine: Awaited<ReturnType<typeof setup>>['engine']) {
    // Previous window: 2026-03-01 → 2026-03-07
    for (const day of ['2026-03-01', '2026-03-02', '2026-03-03']) {
      await engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: day },
        [
          pageRow('/a', day, 5, 50),
          pageRow('/b', day, 1, 10),
        ],
      )
    }
    // Current window: 2026-03-08 → 2026-03-14
    for (const day of ['2026-03-08', '2026-03-09', '2026-03-10']) {
      await engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: day },
        [
          pageRow('/a', day, 10, 100), // doubled
          pageRow('/c', day, 4, 40), // new in current window
        ],
      )
    }
  }

  it('joins current and previous windows with delta columns', async () => {
    const { engine } = await setup()
    await seedTwoWindows(engine)

    const result = await engine.queryComparison(
      { userId: 'u1', siteId: 's1' },
      pagesState('2026-03-08', '2026-03-14'),
      pagesState('2026-03-01', '2026-03-07'),
    )

    const byPage = new Map(result.rows.map(r => [r.page as string, r]))
    // /a: present in both, current 30 vs prev 15
    expect(Number(byPage.get('/a')!.clicks)).toBe(30)
    expect(Number(byPage.get('/a')!.prevClicks)).toBe(15)
    // /c: only in current
    expect(Number(byPage.get('/c')!.clicks)).toBe(12)
    expect(Number(byPage.get('/c')!.prevClicks)).toBe(0)
    // /b: only in previous → not in current rows (LEFT JOIN from current)
    expect(byPage.has('/b')).toBe(false)
  })

  it('filter=new returns only rows missing from previous', async () => {
    const { engine } = await setup()
    await seedTwoWindows(engine)

    const result = await engine.queryComparison(
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

    const result = await engine.queryComparison(
      { userId: 'u1', siteId: 's1' },
      pagesState('2026-03-08', '2026-03-14'),
      pagesState('2026-03-01', '2026-03-07'),
      'new',
    )
    // Current window unfiltered totals: /a=30, /c=12 → 42 clicks
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
      engine.queryComparison({ userId: 'u1', siteId: 's1' }, pagesS, keywordsS),
    ).rejects.toThrow(/must resolve to the same table/)
  })
})

describe('engine.queryExtras', () => {
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
    const result = await engine.queryExtras(
      { userId: 'u1', siteId: 's1' },
      pagesState('2026-03-01', '2026-03-31'),
    )
    expect(result).toEqual([])
  })
})
