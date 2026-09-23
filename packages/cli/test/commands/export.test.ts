import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '@gscdump/engine'
import { createInspectionStore, createSitemapListStore } from '@gscdump/engine/entities'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '@gscdump/engine/filesystem'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { encodeSiteId } from 'gscdump/tenant'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportToDuckDB } from '../../src/commands/export'

const SITE = 'sc-domain:example.com'
const USER = 'local'
const siteId = encodeSiteId(SITE)

describe('gscdump store export', () => {
  let dataDir: string
  let outPath: string

  beforeEach(async () => {
    resetNodeDuckDB()
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'gscdump-export-'))
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

  it('packs live parquet partitions into one .duckdb file', async () => {
    const engine = makeEngine()

    await engine.writeDay(
      { userId: USER, siteId, table: 'pages', date: '2026-04-10' },
      [
        { url: 'https://example.com/a', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 300 },
        { url: 'https://example.com/b', date: '2026-04-10', clicks: 5, impressions: 80, sum_position: 600 },
      ],
    )
    await engine.writeDay(
      { userId: USER, siteId, table: 'pages', date: '2026-04-11' },
      [
        { url: 'https://example.com/a', date: '2026-04-11', clicks: 12, impressions: 120, sum_position: 360 },
      ],
    )
    await engine.writeDay(
      { userId: USER, siteId, table: 'queries', date: '2026-04-10' },
      [
        { query: 'foo', date: '2026-04-10', clicks: 3, impressions: 50, sum_position: 200 },
      ],
    )

    const result = await exportToDuckDB({
      engine,
      dataDir,
      userId: USER,
      siteId,
      outPath,
      force: true,
    })

    expect(result.tables.map(t => t.table).sort()).toEqual(['pages', 'queries'])
    expect(result.tables.find(t => t.table === 'pages')).toMatchObject({ files: 2, rows: 3 })
    expect(result.tables.find(t => t.table === 'queries')).toMatchObject({ files: 1, rows: 1 })
    expect(result.totalRows).toBe(4)

    // Round-trip: attach read-only with a fresh DuckDB instance and verify contents
    const verify = await DuckDBInstance.create(':memory:')
    const conn = await verify.connect()
    try {
      await conn.run(`ATTACH '${outPath}' AS v (READ_ONLY)`)
      const pages = await conn.runAndReadAll('SELECT url, clicks::INT AS clicks FROM v.pages ORDER BY url, date')
      // engine.writeDay normalises urls (strips scheme+host) — see PIVOT #19.
      expect(pages.getRowObjects()).toEqual([
        { url: '/a', clicks: 10 },
        { url: '/a', clicks: 12 },
        { url: '/b', clicks: 5 },
      ])
      const kw = await conn.runAndReadAll('SELECT query, clicks::INT AS clicks FROM v.queries')
      expect(kw.getRowObjects()).toEqual([{ query: 'foo', clicks: 3 }])
    }
    finally {
      conn.closeSync()
      verify.closeSync()
    }
  })

  it('returns empty result when no data is synced', async () => {
    const engine = makeEngine()
    const result = await exportToDuckDB({
      engine,
      dataDir,
      userId: USER,
      outPath,
      force: true,
    })
    expect(result.tables).toEqual([])
    expect(result.totalRows).toBe(0)
  })

  it('filters by site when siteId is provided', async () => {
    const engine = makeEngine()
    const otherSiteId = encodeSiteId('sc-domain:other.com')

    await engine.writeDay(
      { userId: USER, siteId, table: 'pages', date: '2026-04-10' },
      [{ url: 'https://example.com/a', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 30 }],
    )
    await engine.writeDay(
      { userId: USER, siteId: otherSiteId, table: 'pages', date: '2026-04-10' },
      [{ url: 'https://other.com/a', date: '2026-04-10', clicks: 99, impressions: 99, sum_position: 99 }],
    )

    const result = await exportToDuckDB({
      engine,
      dataDir,
      userId: USER,
      siteId,
      outPath,
      force: true,
    })
    const pages = result.tables.find(t => t.table === 'pages')
    expect(pages?.rows).toBe(1)
  })

  it('packs entity datasets and keeps search types apart, reporting the file size', async () => {
    const engine = makeEngine()
    const dataSource = createFilesystemDataSource({ rootDir: dataDir })
    const ctx = { userId: USER, siteId }
    const row = { url: '/a', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 0 }
    await engine.writeDay({ ...ctx, table: 'pages', date: '2026-04-10' }, [row])
    await engine.writeDay({ ...ctx, table: 'pages', date: '2026-04-10', searchType: 'image' }, [{ ...row, clicks: 7 }])
    await createInspectionStore({ dataSource }).appendHistory(ctx, [
      { url: 'https://example.com/a', inspectedAt: '2026-04-01T00:00:00.000Z', indexStatus: 'FAIL' },
      { url: 'https://example.com/a', inspectedAt: '2026-05-01T00:00:00.000Z', indexStatus: 'PASS' },
    ])
    await createSitemapListStore({ dataSource }).save(ctx, {
      version: 1,
      fetchedAt: '2026-05-03T00:00:00.000Z',
      sitemaps: [{ path: 'https://example.com/sitemap.xml', type: 'sitemap', isPending: false, isSitemapsIndex: false, lastSubmitted: null, lastDownloaded: null, warnings: 0, errors: 0, contents: [] }],
    })

    const result = await exportToDuckDB({ engine, dataDir, userId: USER, siteId, outPath, force: true })

    expect(result.tables.map(t => [t.table, t.rows])).toEqual([
      ['pages', 2],
      ['inspections', 1],
      ['inspection_history', 2],
      ['sitemaps', 1],
    ])
    expect(result.bytes).toBe((await stat(outPath)).size)
    expect(result.skipped).toEqual(['sitemap_urls', 'indexing_metadata'])

    const verify = await DuckDBInstance.create(':memory:')
    const conn = await verify.connect()
    try {
      await conn.run(`ATTACH '${outPath}' AS v (READ_ONLY)`)
      const pages = await conn.runAndReadAll('SELECT search_type, site_id, clicks::INT AS clicks FROM v.pages ORDER BY search_type')
      expect(pages.getRowObjects()).toEqual([
        { search_type: 'image', site_id: siteId, clicks: 7 },
        { search_type: 'web', site_id: siteId, clicks: 1 },
      ])
      const latest = await conn.runAndReadAll('SELECT site_id, url, index_status FROM v.inspections')
      expect(latest.getRowObjects()).toEqual([{ site_id: siteId, url: 'https://example.com/a', index_status: 'PASS' }])
    }
    finally {
      conn.closeSync()
      verify.closeSync()
    }
  })
})
