import type { Row } from '@gscdump/engine/contracts'
import type { SnapshotIndex } from '@gscdump/engine/snapshot'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { analyzeInBrowser, runAnalyzerWithEngine as rawRunAnalyzerWithEngine } from '@gscdump/analysis'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
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
  attachParquetIndex,
  attachSnapshotIndex,
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '@gscdump/engine/node'
import { encodeSiteId } from 'gscdump'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportToDuckDB } from '../../src/commands/export'

function runAnalyzerWithEngine(
  deps: Parameters<typeof rawRunAnalyzerWithEngine>[0],
  ctx: Parameters<typeof rawRunAnalyzerWithEngine>[1],
  params: Parameters<typeof rawRunAnalyzerWithEngine>[2],
): ReturnType<typeof rawRunAnalyzerWithEngine> {
  return rawRunAnalyzerWithEngine(deps, ctx, params, defaultAnalyzerRegistry)
}

const SITE = 'sc-domain:example.com'
const USER = 'local'
const siteId = encodeSiteId(SITE)

describe('analyzeInBrowser ↔ runAnalyzerWithEngine parity', () => {
  let dataDir: string
  let outPath: string

  beforeEach(async () => {
    resetNodeDuckDB()
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'gscdump-browser-'))
    outPath = path.join(dataDir, 'export.duckdb')
  })

  afterEach(async () => {
    resetNodeDuckDB()
    await rm(dataDir, { recursive: true, force: true })
  })

  function makeEngine() {
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const dataSource = createFilesystemDataSource({ rootDir: dataDir })
    const manifestStore = createFilesystemManifestStore({
      path: path.join(dataDir, 'manifest.json'),
    })
    return createStorageEngine({
      dataSource,
      manifestStore,
      codec: createDuckDBCodec(factory),
      executor: createDuckDBExecutor(factory),
    })
  }

  it('striking-distance: server and browser paths return identical rows', async () => {
    const engine = makeEngine()

    // Seed enough page_keywords data to trigger a striking-distance candidate:
    // position ≈ 6 (between 4 and 20), impressions ≥ 100, ctr ≤ 0.05.
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-04-10' },
      [
        { url: 'https://example.com/a', query: 'striking one', date: '2026-04-10', clicks: 2, impressions: 500, sum_position: 2500 },
        { url: 'https://example.com/b', query: 'striking two', date: '2026-04-10', clicks: 1, impressions: 200, sum_position: 1000 },
        { url: 'https://example.com/x', query: 'top', date: '2026-04-10', clicks: 100, impressions: 500, sum_position: 500 }, // excluded (pos ≈ 2)
        { url: 'https://example.com/y', query: 'too small', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }, // excluded (impressions)
      ],
    )

    // Server-side path
    const server = await runAnalyzerWithEngine(
      { engine },
      { userId: USER, siteId },
      { type: 'striking-distance', startDate: '2026-04-10', endDate: '2026-04-10', limit: 100 },
    )
    expect(server.results.length).toBeGreaterThan(0)

    // Export to a .duckdb file
    await exportToDuckDB({ engine, dataDir, userId: USER, siteId, outPath, force: true })

    // Browser-equivalent path: attach and run through analyzeInBrowser
    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    await conn.run(`ATTACH '${outPath}' AS gsc (READ_ONLY)`)

    const runner = {
      async query(sql: string, params?: unknown[]): Promise<Row[]> {
        const reader = params && params.length > 0
          ? await conn.runAndReadAll(sql, params as any)
          : await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Row[]
      },
    }

    try {
      const browser = await analyzeInBrowser(
        runner,
        { schema: 'gsc' },
        { type: 'striking-distance', startDate: '2026-04-10', endDate: '2026-04-10', limit: 100 },
        defaultAnalyzerRegistry,
      )

      // Same rows, same ordering, same counts.
      expect(browser.results.length).toBe(server.results.length)
      expect(browser.results).toEqual(server.results)
      expect(browser.meta?.tool).toBe('striking-distance')
      expect(browser.meta?.source).toBe('browser')
      expect(server.meta?.source).toBe('local')
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })

  it('movers: rewrite covers FILES_PREV and produces identical rows', async () => {
    const engine = makeEngine()

    // Current period: 2026-04-10..11. Previous: 2026-03-10..11.
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-04-10' },
      [
        { url: 'https://example.com/a', query: 'stable', date: '2026-04-10', clicks: 10, impressions: 1000, sum_position: 10000 },
        { url: 'https://example.com/b', query: 'rising', date: '2026-04-10', clicks: 40, impressions: 1000, sum_position: 10000 },
      ],
    )
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-04-11' },
      [
        { url: 'https://example.com/a', query: 'stable', date: '2026-04-11', clicks: 10, impressions: 1000, sum_position: 10000 },
        { url: 'https://example.com/b', query: 'rising', date: '2026-04-11', clicks: 40, impressions: 1000, sum_position: 10000 },
      ],
    )
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-03-10' },
      [
        { url: 'https://example.com/a', query: 'stable', date: '2026-03-10', clicks: 10, impressions: 1000, sum_position: 10000 },
        { url: 'https://example.com/b', query: 'rising', date: '2026-03-10', clicks: 5, impressions: 1000, sum_position: 10000 },
      ],
    )
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-03-11' },
      [
        { url: 'https://example.com/a', query: 'stable', date: '2026-03-11', clicks: 10, impressions: 1000, sum_position: 10000 },
        { url: 'https://example.com/b', query: 'rising', date: '2026-03-11', clicks: 5, impressions: 1000, sum_position: 10000 },
      ],
    )

    const params = {
      type: 'movers',
      startDate: '2026-04-10',
      endDate: '2026-04-11',
      prevStartDate: '2026-03-10',
      prevEndDate: '2026-03-11',
      limit: 100,
    } as const

    const server = await runAnalyzerWithEngine({ engine }, { userId: USER, siteId }, params)
    await exportToDuckDB({ engine, dataDir, userId: USER, siteId, outPath, force: true })

    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    await conn.run(`ATTACH '${outPath}' AS gsc (READ_ONLY)`)

    const runner = {
      async query(sql: string, p?: unknown[]): Promise<Row[]> {
        const reader = p && p.length > 0
          ? await conn.runAndReadAll(sql, p as any)
          : await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Row[]
      },
    }

    try {
      const browser = await analyzeInBrowser(runner, { schema: 'gsc' }, params, defaultAnalyzerRegistry)
      expect(browser.results).toEqual(server.results)
      expect(browser.meta?.rising).toBe(server.meta?.rising)
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })

  it('zero-click: high-impression low-CTR rows match across backends', async () => {
    const engine = makeEngine()

    // Seed page_keywords so at least one row qualifies:
    //   impressions >= 1000 (default), position <= 10, ctr < 0.03.
    // sum_position values below give position = sum_position/impressions + 1.
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-04-10' },
      [
        // qualifier: pos ≈ 5, imps 2000, ctr = 20/2000 = 0.01
        { url: 'https://example.com/a', query: 'zero click one', date: '2026-04-10', clicks: 20, impressions: 2000, sum_position: 8000 },
        // qualifier: pos ≈ 2, imps 5000, ctr = 100/5000 = 0.02
        { url: 'https://example.com/b', query: 'zero click two', date: '2026-04-10', clicks: 100, impressions: 5000, sum_position: 5000 },
        // excluded (ctr too high: 0.10)
        { url: 'https://example.com/c', query: 'healthy', date: '2026-04-10', clicks: 150, impressions: 1500, sum_position: 4500 },
        // excluded (impressions too low)
        { url: 'https://example.com/d', query: 'too small', date: '2026-04-10', clicks: 0, impressions: 50, sum_position: 250 },
        // excluded (position > 10, sum_position/impressions + 1 = 11)
        { url: 'https://example.com/e', query: 'too deep', date: '2026-04-10', clicks: 5, impressions: 2000, sum_position: 20000 },
      ],
    )

    const params = {
      type: 'zero-click',
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      limit: 100,
    } as const

    const server = await runAnalyzerWithEngine({ engine }, { userId: USER, siteId }, params)
    expect(server.results.length).toBeGreaterThan(0)

    await exportToDuckDB({ engine, dataDir, userId: USER, siteId, outPath, force: true })

    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    await conn.run(`ATTACH '${outPath}' AS gsc (READ_ONLY)`)

    const runner = {
      async query(sql: string, p?: unknown[]): Promise<Row[]> {
        const reader = p && p.length > 0
          ? await conn.runAndReadAll(sql, p as any)
          : await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Row[]
      },
    }

    try {
      const browser = await analyzeInBrowser(runner, { schema: 'gsc' }, params, defaultAnalyzerRegistry)
      expect(browser.results).toEqual(server.results)
      expect(browser.meta?.tool).toBe('zero-click')
      expect(browser.meta?.minImpressions).toBe(1000)
      expect(browser.meta?.maxCtr).toBe(0.03)
      expect(browser.meta?.maxPosition).toBe(10)
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })

  it('opportunity: matches rows across backends', async () => {
    const engine = makeEngine()

    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-04-10' },
      [
        { url: 'https://example.com/p', query: 'mid', date: '2026-04-10', clicks: 20, impressions: 1000, sum_position: 11000 },
        { url: 'https://example.com/q', query: 'high', date: '2026-04-10', clicks: 50, impressions: 500, sum_position: 2500 },
      ],
    )
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-04-11' },
      [
        { url: 'https://example.com/p', query: 'mid', date: '2026-04-11', clicks: 22, impressions: 1100, sum_position: 12100 },
      ],
    )

    const params = { type: 'opportunity', startDate: '2026-04-10', endDate: '2026-04-11', limit: 100 } as const
    const server = await runAnalyzerWithEngine(
      { engine },
      { userId: USER, siteId },
      params,
    )
    await exportToDuckDB({ engine, dataDir, userId: USER, siteId, outPath, force: true })

    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    await conn.run(`ATTACH '${outPath}' AS gsc (READ_ONLY)`)

    const runner = {
      async query(sql: string, p?: unknown[]): Promise<Row[]> {
        const reader = p && p.length > 0
          ? await conn.runAndReadAll(sql, p as any)
          : await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Row[]
      },
    }

    try {
      const browser = await analyzeInBrowser(runner, { schema: 'gsc' }, params, defaultAnalyzerRegistry)
      // opportunityScore ties between rows → DuckDB instances differ in tie-break
      // order (server-side blocking wasm vs browser-side native @duckdb/node-api).
      // Sort by a stable key before comparison; set equality is what matters here.
      const byKeyword = (a: any, b: any) => String(a.keyword).localeCompare(String(b.keyword))
      expect([...browser.results].sort(byKeyword))
        .toEqual([...server.results].sort(byKeyword))
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })
})

describe('attachSnapshotIndex', () => {
  let dataDir: string

  beforeEach(async () => {
    resetNodeDuckDB()
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'gscdump-snap-'))
  })

  afterEach(async () => {
    resetNodeDuckDB()
    await rm(dataDir, { recursive: true, force: true })
  })

  function makeEngine() {
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const dataSource = createFilesystemDataSource({ rootDir: dataDir })
    const manifestStore = createFilesystemManifestStore({
      path: path.join(dataDir, 'manifest.json'),
    })
    return createStorageEngine({
      dataSource,
      manifestStore,
      codec: createDuckDBCodec(factory),
      executor: createDuckDBExecutor(factory),
    })
  }

  it('hot/cold UNION views produce rows identical to the server-side path', async () => {
    const engine = makeEngine()

    // Seed two months of page_keywords: March (cold) and April (hot).
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-03-15' },
      [
        { url: 'https://example.com/a', query: 'striking cold', date: '2026-03-15', clicks: 2, impressions: 500, sum_position: 2500 },
        { url: 'https://example.com/b', query: 'striking cold two', date: '2026-03-15', clicks: 1, impressions: 300, sum_position: 1500 },
      ],
    )
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-04-10' },
      [
        { url: 'https://example.com/c', query: 'striking hot', date: '2026-04-10', clicks: 3, impressions: 600, sum_position: 3000 },
        { url: 'https://example.com/d', query: 'striking hot two', date: '2026-04-10', clicks: 1, impressions: 200, sum_position: 1000 },
      ],
    )

    const params = {
      type: 'striking-distance',
      startDate: '2026-03-15',
      endDate: '2026-04-10',
      limit: 100,
    } as const

    const server = await runAnalyzerWithEngine({ engine }, { userId: USER, siteId }, params)
    expect(server.results.length).toBeGreaterThan(0)

    // Split live parquet URIs by month.
    const live = await engine.listLive({ userId: USER, siteId, table: 'page_queries' })
    const march = live.filter(e => e.partition.includes('2026-03')).map(e => path.join(dataDir, e.objectKey))
    const april = live.filter(e => e.partition.includes('2026-04')).map(e => path.join(dataDir, e.objectKey))
    expect(march.length).toBeGreaterThan(0)
    expect(april.length).toBeGreaterThan(0)

    const coldPath = path.join(dataDir, 'snap-cold-2026-03.duckdb')
    const hotPath = path.join(dataDir, 'snap-hot.duckdb')

    // Build the cold March file.
    {
      const inst = await DuckDBInstance.create(coldPath)
      const conn = await inst.connect()
      try {
        const list = march.map(p => `'${p.replace(/'/g, '\'\'')}'`).join(', ')
        await conn.run(`CREATE TABLE page_queries AS SELECT * FROM read_parquet([${list}], union_by_name=true)`)
      }
      finally {
        conn.closeSync()
        inst.closeSync()
      }
    }

    // Build the hot April file.
    {
      const inst = await DuckDBInstance.create(hotPath)
      const conn = await inst.connect()
      try {
        const list = april.map(p => `'${p.replace(/'/g, '\'\'')}'`).join(', ')
        await conn.run(`CREATE TABLE page_queries AS SELECT * FROM read_parquet([${list}], union_by_name=true)`)
      }
      finally {
        conn.closeSync()
        inst.closeSync()
      }
    }

    // Open a fresh in-memory instance and wrap as a SnapshotQueryRunner.
    const browserInst = await DuckDBInstance.create(':memory:')
    const browserConn = await browserInst.connect()
    try {
      const runner = async (sql: string): Promise<Array<Record<string, unknown>>> => {
        const reader = await browserConn.runAndReadAll(sql)
        return reader.getRowObjects() as Array<Record<string, unknown>>
      }

      const index: SnapshotIndex = {
        version: 1,
        builtAt: '2026-04-12',
        cold: ['2026-03'],
        hot: true,
        hotDays: 30,
      }
      const attachUrls = {
        'cold-2026-03.duckdb': coldPath,
        'hot.duckdb': hotPath,
      }

      const result = await attachSnapshotIndex(runner, { index, attachUrls, schema: 'main' })
      expect(result.aliases).toEqual(['cold_2026_03', 'hot'])
      expect(result.tables).toEqual(['page_queries'])
      expect(result.schema).toBe('main')

      // Analyzer runner adaptor: analyzeInBrowser wants params support.
      const analyzerRunner = {
        async query(sql: string, p?: unknown[]): Promise<Row[]> {
          const reader = p && p.length > 0
            ? await browserConn.runAndReadAll(sql, p as any)
            : await browserConn.runAndReadAll(sql)
          return reader.getRowObjects() as Row[]
        },
      }

      const browser = await analyzeInBrowser(analyzerRunner, { schema: 'main' }, params, defaultAnalyzerRegistry)
      expect(browser.results).toEqual(server.results)
    }
    finally {
      browserConn.closeSync()
      browserInst.closeSync()
    }
  })

  it('handles mismatched column sets across cold/hot with UNION BY NAME', async () => {
    // Two snapshot .duckdb files whose `pages` tables differ in shape:
    //   cold has (url, date, clicks)
    //   hot  has (url, date, clicks, impressions)
    // Without `UNION ALL BY NAME`, this fails with a column-count mismatch.
    const coldPath = path.join(dataDir, 'cold-2026-03.duckdb')
    const hotPath = path.join(dataDir, 'hot.duckdb')

    {
      const inst = await DuckDBInstance.create(coldPath)
      const conn = await inst.connect()
      try {
        await conn.run(`CREATE TABLE pages (url VARCHAR, date DATE, clicks INTEGER)`)
        await conn.run(`INSERT INTO pages VALUES ('/a', DATE '2026-03-10', 5)`)
      }
      finally {
        conn.closeSync()
        inst.closeSync()
      }
    }
    {
      const inst = await DuckDBInstance.create(hotPath)
      const conn = await inst.connect()
      try {
        await conn.run(`CREATE TABLE pages (url VARCHAR, date DATE, clicks INTEGER, impressions INTEGER)`)
        await conn.run(`INSERT INTO pages VALUES ('/b', DATE '2026-04-10', 3, 42)`)
      }
      finally {
        conn.closeSync()
        inst.closeSync()
      }
    }

    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    try {
      const runner = async (sql: string): Promise<Array<Record<string, unknown>>> => {
        const reader = await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Array<Record<string, unknown>>
      }
      const result = await attachSnapshotIndex(runner, {
        index: { version: 1, builtAt: '2026-04-12', cold: ['2026-03'], hot: true, hotDays: 30 },
        attachUrls: { 'cold-2026-03.duckdb': coldPath, 'hot.duckdb': hotPath },
        schema: 'main',
      })
      expect(result.tables).toEqual(['pages'])

      // Unioned view returns 2 rows: one from cold (no impressions → NULL),
      // one from hot (impressions filled in).
      const rows = await runner('SELECT url, impressions FROM main.pages ORDER BY url')
      expect(rows).toEqual([
        { url: '/a', impressions: null },
        { url: '/b', impressions: 42 },
      ])
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })

  it('throws when attachUrls is missing an entry required by the index', async () => {
    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    try {
      const runner = async (sql: string): Promise<Array<Record<string, unknown>>> => {
        const reader = await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Array<Record<string, unknown>>
      }
      await expect(attachSnapshotIndex(runner, {
        index: { version: 1, builtAt: '2026-04-12', cold: ['2026-03'], hot: false, hotDays: 0 },
        attachUrls: {},
      })).rejects.toThrow(/cold-2026-03\.duckdb/)
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })

  it('rejects a YYYY-MM entry with an invalid shape (SQL-injection guardrail)', async () => {
    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    try {
      const runner = async (sql: string): Promise<Array<Record<string, unknown>>> => {
        const reader = await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Array<Record<string, unknown>>
      }
      await expect(attachSnapshotIndex(runner, {
        index: { version: 1, builtAt: '2026-04-12', cold: ['2026/03'], hot: false, hotDays: 0 },
        attachUrls: { 'cold-2026/03.duckdb': '/tmp/whatever.duckdb' },
      })).rejects.toThrow(TypeError)
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })
})

describe('attachParquetIndex', () => {
  let dataDir: string

  beforeEach(async () => {
    resetNodeDuckDB()
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'gscdump-parq-'))
  })

  afterEach(async () => {
    resetNodeDuckDB()
    await rm(dataDir, { recursive: true, force: true })
  })

  function makeEngine() {
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const dataSource = createFilesystemDataSource({ rootDir: dataDir })
    const manifestStore = createFilesystemManifestStore({
      path: path.join(dataDir, 'manifest.json'),
    })
    return createStorageEngine({
      dataSource,
      manifestStore,
      codec: createDuckDBCodec(factory),
      executor: createDuckDBExecutor(factory),
    })
  }

  it('views over raw parquet URLs produce rows identical to the server-side path', async () => {
    const engine = makeEngine()

    // Seed two days of page_keywords so the test has real parquets to read.
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-03-15' },
      [
        { url: 'https://example.com/a', query: 'striking one', date: '2026-03-15', clicks: 2, impressions: 500, sum_position: 2500 },
      ],
    )
    await engine.writeDay(
      { userId: USER, siteId, table: 'page_queries', date: '2026-04-10' },
      [
        { url: 'https://example.com/b', query: 'striking two', date: '2026-04-10', clicks: 3, impressions: 600, sum_position: 3000 },
      ],
    )

    const params = {
      type: 'striking-distance',
      startDate: '2026-03-15',
      endDate: '2026-04-10',
      limit: 100,
    } as const

    const server = await runAnalyzerWithEngine({ engine }, { userId: USER, siteId }, params)
    expect(server.results.length).toBeGreaterThan(0)

    const live = await engine.listLive({ userId: USER, siteId, table: 'page_queries' })
    const parquetUrls = live.map(e => path.join(dataDir, e.objectKey))
    expect(parquetUrls.length).toBeGreaterThan(0)

    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    try {
      const runner = async (sql: string): Promise<Array<Record<string, unknown>>> => {
        const reader = await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Array<Record<string, unknown>>
      }

      const result = await attachParquetIndex(runner, {
        tables: { page_queries: parquetUrls },
        schema: 'main',
      })
      expect(result.schema).toBe('main')
      expect(result.tables).toEqual(['page_queries'])

      const analyzerRunner = {
        async query(sql: string, p?: unknown[]): Promise<Row[]> {
          const reader = p && p.length > 0
            ? await conn.runAndReadAll(sql, p as any)
            : await conn.runAndReadAll(sql)
          return reader.getRowObjects() as Row[]
        },
      }
      const browser = await analyzeInBrowser(analyzerRunner, { schema: 'main' }, params, defaultAnalyzerRegistry)
      expect(browser.results).toEqual(server.results)
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })

  it('skips tables with empty URL lists', async () => {
    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    try {
      const runner = async (sql: string): Promise<Array<Record<string, unknown>>> => {
        const reader = await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Array<Record<string, unknown>>
      }
      const result = await attachParquetIndex(runner, {
        tables: { pages: [] },
      })
      expect(result.tables).toEqual([])
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })

  it('rejects invalid schema and table identifiers', async () => {
    const inst = await DuckDBInstance.create(':memory:')
    const conn = await inst.connect()
    try {
      const runner = async (sql: string): Promise<Array<Record<string, unknown>>> => {
        const reader = await conn.runAndReadAll(sql)
        return reader.getRowObjects() as Array<Record<string, unknown>>
      }
      await expect(attachParquetIndex(runner, {
        tables: { pages: ['/tmp/x.parquet'] },
        schema: 'has space',
      })).rejects.toThrow(TypeError)
      await expect(attachParquetIndex(runner, {
        tables: { 'pages; DROP': ['/tmp/x.parquet'] },
      })).rejects.toThrow(TypeError)
    }
    finally {
      conn.closeSync()
      inst.closeSync()
    }
  })
})
