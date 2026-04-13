import type { Row } from '../../src/analytics'
import type { BuilderState } from '../../src/query/types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createStorageEngine,
  dayPartition,
} from '../../src/analytics'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '../../src/analytics/adapters/duckdb-node'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '../../src/analytics/adapters/filesystem'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
} from '../../src/analytics/duckdb'

afterAll(() => {
  resetNodeDuckDB()
})

function pageRow(url: string, date: string, clicks: number, impressions: number): Row {
  return { url, date, clicks, impressions, sum_position: impressions * 5 }
}

function stateForRange(start: string, end: string): BuilderState {
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
  }
}

describe('integration: real DuckDB + filesystem', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-e2e-'))
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
    return { engine, dataSource, manifestStore, codec, executor }
  }

  it('writeDay → query → compactDay → query → compactMonth → query', async () => {
    const { engine, manifestStore } = await setup()

    for (const day of ['2026-03-01', '2026-03-15', '2026-03-31']) {
      await engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: day },
        [
          pageRow('/', day, 10, 100),
          pageRow('/about', day, 5, 50),
        ],
      )
    }

    const state = stateForRange('2026-03-01', '2026-03-31')
    const q1 = await engine.query({ userId: 'u1', siteId: 's1' }, state)

    expect(q1.rows.length).toBe(2)
    const root = q1.rows.find(r => r.page === '/')!
    expect(Number(root.clicks)).toBe(30)
    expect(Number(root.impressions)).toBe(300)

    const dayEntries = await manifestStore.listLive({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      partitions: [dayPartition('2026-03-15')],
    })
    await engine.compactDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-03-15' },
      dayEntries,
    )

    const q2 = await engine.query({ userId: 'u1', siteId: 's1' }, state)
    expect(q2.rows.length).toBe(2)
    const root2 = q2.rows.find(r => r.page === '/')!
    expect(Number(root2.clicks)).toBe(30)

    await engine.compactMonth(
      { userId: 'u1', siteId: 's1', table: 'pages' },
      '2026-03',
    )

    const q3 = await engine.query({ userId: 'u1', siteId: 's1' }, state)
    expect(q3.rows.length).toBe(2)
    expect(q3.objectKeys.length).toBe(1)
    expect(q3.objectKeys[0]).toContain('monthly/2026-03')

    const root3 = q3.rows.find(r => r.page === '/')!
    expect(Number(root3.clicks)).toBe(30)
    expect(Number(root3.impressions)).toBe(300)
  }, 30_000)

  it('resolver WHERE + GROUP BY + HAVING filters rows correctly', async () => {
    const { engine } = await setup()

    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-01' },
      [
        pageRow('/high', '2026-04-01', 100, 1000),
        pageRow('/low', '2026-04-01', 1, 10),
      ],
    )

    const state: BuilderState = {
      dimensions: ['page'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-04-01', expression2: '2026-04-01' },
          { dimension: 'clicks', operator: 'metricGte', expression: '50' },
        ],
      } as any,
    }

    const result = await engine.query({ userId: 'u1', siteId: 's1' }, state)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].page).toBe('/high')
  }, 30_000)
})
