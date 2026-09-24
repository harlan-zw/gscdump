import type { BuilderState } from 'gscdump/query'
import type { Row } from '../src/index'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '../src/adapters/duckdb-node'
import { createFilesystemDataSource, createFilesystemManifestStore } from '../src/adapters/filesystem'
import { createDuckDBCodec, createDuckDBExecutor } from '../src/duckdb'
import { createStorageEngine } from '../src/index'

afterAll(() => {
  resetNodeDuckDB()
})

const DAY = '2026-09-01'

// Four URLs that all store as `/a`, plus one that keeps its query string.
const collidingRows: Row[] = [
  { url: 'https://x.com/a', date: DAY, clicks: 5, impressions: 50, sum_position: 100 },
  { url: 'https://www.x.com/a', date: DAY, clicks: 3, impressions: 30, sum_position: 60 },
  { url: 'http://x.com/a', date: DAY, clicks: 2, impressions: 20, sum_position: 40 },
  { url: '/a', date: DAY, clicks: 1, impressions: 10, sum_position: 20 },
  { url: 'https://x.com/a?ref=1', date: DAY, clicks: 4, impressions: 40, sum_position: 80 },
]

const pagesState: BuilderState = {
  dimensions: ['page'],
  filter: {
    _filters: [{ dimension: 'date', operator: 'between', expression: DAY, expression2: DAY }],
  } as unknown as BuilderState['filter'],
}

describe('write paths sum rows that share a stored key', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-collisions-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function setup() {
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const codec = createDuckDBCodec(factory)
    const dataSource = createFilesystemDataSource({ rootDir: dir })
    const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor: createDuckDBExecutor(factory) })
    return { engine, codec, dataSource, manifestStore }
  }

  async function pageMetrics(engine: ReturnType<typeof setup>['engine']) {
    const result = await engine.query({ userId: 'u', siteId: 's' }, pagesState)
    return Object.fromEntries(result.rows.map(r => [String(r.page), {
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
    }]))
  }

  it('writeDay sums URL variants that normalize to one path', async () => {
    const { engine } = setup()
    await engine.writeDay({ userId: 'u', siteId: 's', table: 'pages', date: DAY }, collidingRows)

    expect(await pageMetrics(engine)).toEqual({
      '/a': { clicks: 11, impressions: 110 },
      '/a?ref=1': { clicks: 4, impressions: 40 },
    })
  })

  it('writeDay replaces the day when the same rows are written twice', async () => {
    const { engine } = setup()
    const ctx = { userId: 'u', siteId: 's', table: 'pages' as const, date: DAY }
    await engine.writeDay({ ...ctx, now: () => 1000 }, collidingRows)
    await engine.writeDay({ ...ctx, now: () => 2000 }, collidingRows)

    expect(await pageMetrics(engine)).toEqual({
      '/a': { clicks: 11, impressions: 110 },
      '/a?ref=1': { clicks: 4, impressions: 40 },
    })
  })

  it('writeHour sums variants within a batch and replaces the bucket across calls', async () => {
    const { engine, codec, dataSource, manifestStore } = setup()
    const ctx = { userId: 'u', siteId: 's', table: 'hourly_pages' as const, date: DAY, searchType: 'discover' as const }
    const hourRows: Row[] = [
      { url: 'https://x.com/a', hour: 8, date: DAY, clicks: 5, impressions: 50, sum_position: 100 },
      { url: 'https://www.x.com/a', hour: 8, date: DAY, clicks: 3, impressions: 30, sum_position: 60 },
      { url: 'https://x.com/a', hour: 9, date: DAY, clicks: 1, impressions: 10, sum_position: 20 },
    ]
    await engine.writeHour({ ...ctx, now: () => 1000 }, hourRows)
    await engine.writeHour({ ...ctx, now: () => 2000 }, hourRows)

    const [entry, ...rest] = await manifestStore.listLive({ userId: 'u', siteId: 's', table: 'hourly_pages', partitions: [`hourly/${DAY}`], searchType: 'discover' })
    expect(rest).toEqual([])
    const stored = await codec.readRows({ table: 'hourly_pages' }, entry!.objectKey, dataSource)
    const byHour = Object.fromEntries(stored.map(r => [`${r.url}@${Number(r.hour)}`, Number(r.clicks)]))
    expect(byHour).toEqual({ '/a@8': 8, '/a@9': 1 })
  })
})
