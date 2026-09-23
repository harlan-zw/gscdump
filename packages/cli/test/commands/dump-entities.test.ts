import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { createIndexingMetadataStore, createInspectionStore, createSitemapListStore, createSitemapStore } from '@gscdump/engine/entities'
import { resetNodeDuckDB } from '@gscdump/engine/node'
import { addDays, getLatestGscDate } from 'gscdump/dates'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dumpSites } from '../../src/commands/dump'
import { createLocalStore } from '../../src/local-store'

const SITE = 'sc-domain:example.com'

async function readParquet(file: string): Promise<Record<string, unknown>[]> {
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet('${file.replace(/'/g, '\'\'')}')`)
    return reader.getRowObjects() as Record<string, unknown>[]
  }
  finally {
    connection.closeSync()
    instance.closeSync()
  }
}

describe('dumpSites entity datasets', () => {
  let dataDir: string
  let outDir: string

  beforeEach(async () => {
    resetNodeDuckDB()
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-dump-'))
    outDir = path.join(dataDir, 'out')
  })

  afterEach(async () => {
    resetNodeDuckDB()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  async function seed(opts: { entities: boolean }) {
    const store = createLocalStore({ dataDir })
    const siteId = store.siteIdFor(SITE)
    const ctx = { userId: store.userId, siteId }
    await store.engine.writeDay(
      { userId: store.userId, siteId, table: 'pages', date: '2026-04-10' },
      [
        { url: 'https://example.com/a', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 300 },
        { url: 'https://example.com/b', date: '2026-04-10', clicks: 5, impressions: 80, sum_position: 600 },
      ],
    )
    if (opts.entities) {
      await createInspectionStore({ dataSource: store.dataSource }).appendHistory(ctx, [
        { url: 'https://example.com/a', inspectedAt: '2026-04-01T00:00:00.000Z', indexStatus: 'FAIL', coverageState: 'Crawled - currently not indexed' },
        { url: 'https://example.com/a', inspectedAt: '2026-05-01T00:00:00.000Z', indexStatus: 'PASS', coverageState: 'Submitted and indexed' },
        { url: 'https://example.com/b', inspectedAt: '2026-05-02T00:00:00.000Z', indexStatus: 'PASS' },
      ])
      await createSitemapListStore({ dataSource: store.dataSource }).save(ctx, {
        version: 1,
        fetchedAt: '2026-05-03T00:00:00.000Z',
        sitemaps: [{
          path: 'https://example.com/sitemap.xml',
          type: 'sitemap',
          isPending: false,
          isSitemapsIndex: false,
          lastSubmitted: '2026-04-01T00:00:00.000Z',
          lastDownloaded: '2026-05-02T00:00:00.000Z',
          warnings: 0,
          errors: 1,
          contents: [{ type: 'web', submitted: 2, indexed: null }],
        }],
      })
      await createIndexingMetadataStore({ dataSource: store.dataSource }).writeBatch(ctx, [
        { url: 'https://example.com/a', capturedAt: '2026-05-03T00:00:00.000Z', latestUpdateAt: '2026-05-01T00:00:00.000Z' },
      ])
      const sitemaps = createSitemapStore({ dataSource: store.dataSource, withMutation: (_ctx, effect) => effect() })
      const generation = { _tag: 'complete' as const, id: 'g1', observedAt: Date.parse('2026-05-03T00:00:00.000Z') }
      await sitemaps.stageSitemapGenerationFeed(ctx, generation, 'https://example.com/sitemap.xml', [
        { loc: 'https://example.com/a', lastmod: '2026-04-30' },
        { loc: 'https://example.com/b' },
      ])
      await sitemaps.finalizeSitemapGeneration(ctx, generation, {
        _tag: 'complete',
        expectedFeedpaths: ['https://example.com/sitemap.xml'],
      })
    }
    return { store, target: { site: SITE, siteId } }
  }

  it('writes each entity dataset as Parquet and reports every file with bytes and rows', async () => {
    const { store, target } = await seed({ entities: true })

    const { files, sites: [summary] } = await dumpSites({ store, targets: [target], outDir, format: 'parquet' })

    const byDataset = new Map(summary!.datasets.map(file => [file.dataset, file]))
    expect([...byDataset.keys()].sort()).toEqual(['indexing_metadata', 'inspection_history', 'inspections', 'pages', 'sitemap_urls', 'sitemaps'])
    expect(summary!.datasets.map(dataset => path.relative(outDir, dataset.path)).sort()).toEqual([
      'sc_domain_example_com/indexing_metadata.parquet',
      'sc_domain_example_com/inspection_history.parquet',
      'sc_domain_example_com/inspections.parquet',
      'sc_domain_example_com/sitemap_urls.parquet',
      'sc_domain_example_com/sitemaps.parquet',
      'sc_domain_example_com/web/pages.parquet',
    ])
    for (const file of files)
      expect(file.bytes).toBe((await fs.stat(file.path)).size)
    expect(summary!.totals).toEqual({ datasets: 6, rows: 2 + 2 + 3 + 1 + 2 + 1 })
    expect(summary!.skipped).toEqual([])

    const latest = await readParquet(byDataset.get('inspections')!.path)
    expect(latest.map(row => [row.site, row.url, row.index_status])).toEqual([
      [SITE, 'https://example.com/a', 'PASS'],
      [SITE, 'https://example.com/b', 'PASS'],
    ])
    expect(byDataset.get('inspections')!.rows).toBe(2)
    expect(await readParquet(byDataset.get('inspection_history')!.path)).toHaveLength(3)
    const sitemapRows = await readParquet(byDataset.get('sitemaps')!.path)
    expect(sitemapRows.map(row => [row.path, Number(row.errors), Number(row.submitted)])).toEqual([
      ['https://example.com/sitemap.xml', 1, 2],
    ])
    const urls = await readParquet(byDataset.get('sitemap_urls')!.path)
    expect(urls.map(row => [row.url, row.lastmod])).toEqual([
      ['https://example.com/a', '2026-04-30'],
      ['https://example.com/b', null],
    ])
    expect(byDataset.get('pages')!.rows).toBe(2)
  })

  it('writes one row-format file per entity dataset', async () => {
    const { store, target } = await seed({ entities: true })

    const { sites: [summary] } = await dumpSites({ store, targets: [target], outDir, format: 'ndjson', tables: new Set(['inspections', 'sitemaps']) })

    expect(summary!.datasets.map(file => path.basename(file.path)).sort()).toEqual(['inspections.ndjson', 'sitemaps.ndjson'])
    const inspections = summary!.datasets.find(file => file.dataset === 'inspections')!
    const lines = (await fs.readFile(inspections.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.url)).toEqual(['https://example.com/a', 'https://example.com/b'])
    expect(inspections.rows).toBe(2)
  })

  it('skips empty entity datasets with a note instead of failing', async () => {
    const { store, target } = await seed({ entities: false })

    const { sites: [summary] } = await dumpSites({ store, targets: [target], outDir, format: 'csv' })

    expect(summary!.datasets.map(file => file.dataset)).toEqual(['pages'])
    expect(summary!.skipped.map(skip => skip.dataset).sort()).toEqual(['indexing_metadata', 'inspection_history', 'inspections', 'sitemap_urls', 'sitemaps'])
    expect(summary!.skipped.every(skip => skip.reason === 'empty')).toBe(true)
  })

  it('writes manifest.json with Store coverage and sites.json with the site list', async () => {
    const store = createLocalStore({ dataDir })
    const siteId = store.siteIdFor(SITE)
    const scope = { userId: store.userId, siteId, table: 'pages' as const }
    const latest = getLatestGscDate()
    const [first, failed] = [addDays(latest, -3), addDays(latest, -2)]
    for (const date of [first, latest]) {
      await store.engine.writeDay({ ...scope, date }, [{ url: '/a', date, clicks: 1, impressions: 10, sum_position: 0 }])
      await store.engine.setSyncState({ ...scope, date }, 'done')
    }
    await store.engine.setSyncState({ ...scope, date: failed }, 'failed', { error: 'quota exceeded' })

    const result = await dumpSites({
      store,
      targets: [{ site: SITE, siteId }],
      outDir,
      format: 'parquet',
      siteList: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }],
    })

    expect(result.metadataFiles.map(file => path.basename(file.path))).toEqual(['sites.json', 'manifest.json'])
    const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'))
    expect(manifest.sites[0].coverage.analytics).toEqual([{
      table: 'pages',
      searchType: 'web',
      from: first,
      to: latest,
      coverage: { kind: 'partial', done: 2, total: 4, failed: 1, pending: 1 },
    }])
    expect(result.sites[0]!.coverage).toEqual(manifest.sites[0].coverage)
    expect(manifest.sites[0].datasets[0].path).toBe('sc_domain_example_com/web/pages.parquet')
    const sites = JSON.parse(await fs.readFile(path.join(outDir, 'sites.json'), 'utf8'))
    expect(sites).toEqual({ sites: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] })
  })
})
