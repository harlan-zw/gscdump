/**
 * Engine adapter contract: engine-duckdb-node and engine-duckdb-wasm wrap the
 * shared `pgResolverAdapter` over different runtimes (analytics planner vs.
 * resolver SQL), but must agree on row sets given the same fixture parquet.
 *
 * The test seeds a real Node DuckDB with parquet files via the storage
 * engine, then runs identical builder states through both adapters and
 * asserts identical sorted rows. Failure here means the two paths have
 * diverged — either a planner change broke a column, or a resolver dialect
 * shift introduced a discrepancy.
 */

import type { Row, TenantCtx } from '@gscdump/engine/contracts'
import type { BuilderState } from 'gscdump/query'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '@gscdump/engine'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '@gscdump/engine/filesystem'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '@gscdump/engine/node'
import { createEngineQuerySource } from '@gscdump/engine/source'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachParquetIndex } from '../src/adapters/parquet-attach'

afterAll(() => {
  resetNodeDuckDB()
})

const CTX: TenantCtx = { userId: 'u1', siteId: 's1' }

function pageRow(url: string, date: string, clicks: number, impressions: number): Row {
  return { url, date, clicks, impressions, sum_position: impressions * 5 }
}

function keywordRow(query: string, date: string, clicks: number, impressions: number): Row {
  return { query, date, clicks, impressions, sum_position: impressions * 7 }
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

function keywordsState(start: string, end: string, rest: Partial<BuilderState> = {}): BuilderState {
  return {
    dimensions: ['query'],
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

function sortRows(rows: Array<Record<string, unknown>>, key: string): Array<Record<string, unknown>> {
  return [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])))
}

function normalizeNumeric(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'bigint')
        out[k] = Number(v)
      else
        out[k] = v
    }
    return out
  })
}

describe('contract: engine-duckdb-node vs engine-duckdb-wasm', () => {
  let dir: string

  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(join(tmpdir(), 'gscdump-contract-'))
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

    for (const day of ['2026-04-01', '2026-04-02', '2026-04-03']) {
      await engine.writeDay(
        { ...CTX, table: 'pages', date: day },
        [
          pageRow('/', day, 10, 100),
          pageRow('/about', day, 5, 50),
          pageRow('/blog', day, 2, 25),
        ],
      )
      await engine.writeDay(
        { ...CTX, table: 'keywords', date: day },
        [
          keywordRow('nuxt seo', day, 8, 80),
          keywordRow('vue ssr', day, 4, 40),
        ],
      )
    }

    const liveEntries = await manifestStore.listLive({ userId: CTX.userId, siteId: CTX.siteId })
    const tables: Record<string, string[]> = {}
    for (const e of liveEntries) {
      const path = join(dir, e.objectKey)
      ;(tables[e.table] ??= []).push(path)
    }

    const runner = (sql: string): Promise<Array<Record<string, unknown>>> => handle.query(sql).then(rows => rows as Array<Record<string, unknown>>)
    await attachParquetIndex(runner, { tables })

    const nodeSource = createEngineQuerySource({ engine, ctx: CTX })

    const wasmRunner = {
      query: (sql: string, params?: unknown[]) => handle.query(sql, params).then(rows => rows as Array<Record<string, unknown>>),
    }
    // Build a parallel SqlQuerySource the way engine-duckdb-wasm does, but skip the
    // duckdb-wasm dependency: same `createSqlQuerySource` factory + same
    // `pgResolverAdapter`, executed against the Node handle directly. This is
    // the contract surface that engine-duckdb-wasm publishes.
    const { createSqlQuerySource } = await import('@gscdump/engine/source')
    const { pgResolverAdapter } = await import('@gscdump/engine/resolver')
    const wasmSource = createSqlQuerySource({
      name: 'wasm-contract',
      adapter: pgResolverAdapter,
      execute: (sql, p) => wasmRunner.query(sql, p),
      extraCapabilities: { attachedTables: true },
    })

    return { engine, nodeSource, wasmSource }
  }

  it('agrees on pages dimension over a 3-day window', async () => {
    const { nodeSource, wasmSource } = await setup()
    const state = pagesState('2026-04-01', '2026-04-03')

    const aRaw = await nodeSource.queryRows(state)
    const bRaw = await wasmSource.queryRows(state)
    // eslint-disable-next-line no-console
    console.log('NODE-RAW', aRaw[0])
    // eslint-disable-next-line no-console
    console.log('WASM-RAW', bRaw[0])
    const a = normalizeNumeric(aRaw)
    const b = normalizeNumeric(bRaw)

    expect(sortRows(a, 'page')).toEqual(sortRows(b, 'page'))
    expect(a.length).toBe(3)
  }, 30_000)

  it('agrees on keywords dimension over a 3-day window', async () => {
    const { nodeSource, wasmSource } = await setup()
    const state = keywordsState('2026-04-01', '2026-04-03')

    const a = normalizeNumeric(await nodeSource.queryRows(state))
    const b = normalizeNumeric(await wasmSource.queryRows(state))

    expect(sortRows(a, 'query')).toEqual(sortRows(b, 'query'))
    expect(a.length).toBe(2)
  }, 30_000)

  it('agrees on filtered pages query (clicks >= 5)', async () => {
    const { nodeSource, wasmSource } = await setup()
    const state: BuilderState = {
      dimensions: ['page'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-04-01', expression2: '2026-04-03' },
          { dimension: 'clicks', operator: 'metricGte', expression: '5' },
        ],
      } as any,
    }

    const a = normalizeNumeric(await nodeSource.queryRows(state))
    const b = normalizeNumeric(await wasmSource.queryRows(state))

    expect(sortRows(a, 'page')).toEqual(sortRows(b, 'page'))
  }, 30_000)
})
