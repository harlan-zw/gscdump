import type { DumpFormat } from '../../src/commands/dump'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DuckDBInstance } from '@duckdb/node-api'
import { resetNodeDuckDB } from '@gscdump/engine/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dumpSites } from '../../src/commands/dump'
import { createLocalStore } from '../../src/local-store'

const SITE_A = 'sc-domain:a.example'
const SITE_B = 'https://b.example/'

// Two Sites, two search types. The same page appears under web and image for
// Site A, so a total that ignores search_type double counts it.
const EXPECTED = [
  { site: SITE_B, search_type: 'web', impressions: 5, clicks: 1 },
  { site: SITE_A, search_type: 'image', impressions: 2, clicks: 0 },
  { site: SITE_A, search_type: 'web', impressions: 30, clicks: 4 },
]

async function duckdbRows(sql: string): Promise<Record<string, unknown>[]> {
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    return (await connection.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[]
  }
  finally {
    connection.closeSync()
    instance.closeSync()
  }
}

function sumsSql(from: string): string {
  return `SELECT site, search_type, SUM(impressions)::INT AS impressions, SUM(clicks)::INT AS clicks FROM ${from} GROUP BY ALL ORDER BY site, search_type`
}

describe('dump output formats', () => {
  let dataDir: string
  let outDir: string

  beforeEach(async () => {
    resetNodeDuckDB()
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-dump-formats-'))
    outDir = path.join(dataDir, 'out')
  })

  afterEach(async () => {
    resetNodeDuckDB()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  async function seed() {
    const store = createLocalStore({ dataDir })
    const a = store.siteIdFor(SITE_A)
    const b = store.siteIdFor(SITE_B)
    const write = (siteId: string, date: string, searchType: 'web' | 'image', rows: Array<{ url: string, clicks: number, impressions: number, sum_position: number }>) =>
      store.engine.writeDay({ userId: store.userId, siteId, table: 'pages', date, searchType }, rows.map(row => ({ ...row, date })))
    await write(a, '2026-04-10', 'web', [{ url: '/x', clicks: 3, impressions: 20, sum_position: 40 }])
    await write(a, '2026-04-11', 'web', [{ url: '/x', clicks: 1, impressions: 10, sum_position: 0 }])
    await write(a, '2026-04-10', 'image', [{ url: '/x', clicks: 0, impressions: 2, sum_position: 8 }])
    await write(b, '2026-04-10', 'web', [{ url: '/y', clicks: 1, impressions: 5, sum_position: 5 }])
    await store.engine.writeDay({ userId: store.userId, siteId: a, table: 'queries', date: '2026-04-10' }, [
      { query: 'x', date: '2026-04-10', clicks: 3, impressions: 20, sum_position: 40 },
    ])
    return { store, targets: [{ site: SITE_A, siteId: a }, { site: SITE_B, siteId: b }] }
  }

  async function dump(format: DumpFormat) {
    const { store, targets } = await seed()
    return dumpSites({ store, targets, outDir, format, tables: new Set(['pages', 'queries']) })
  }

  it.each([
    ['parquet', (files: string) => `read_parquet(${files})`],
    ['csv', (files: string) => `read_csv(${files})`],
    ['json', (files: string) => `read_json(${files})`],
    ['ndjson', (files: string) => `read_json(${files}, format = 'newline_delimited')`],
  ] as const)('%s files carry site and search_type, so totals per search type are exact', async (format, reader) => {
    const result = await dump(format)

    const pages = result.sites.flatMap(site => site.datasets).filter(dataset => dataset.dataset === 'pages')
    expect(pages.map(dataset => path.relative(outDir, dataset.path)).sort()).toEqual([
      `https_b_example_/web/pages.${format}`,
      `sc_domain_a_example/image/pages.${format}`,
      `sc_domain_a_example/web/pages.${format}`,
    ])
    const files = `[${pages.map(dataset => `'${dataset.path}'`).join(', ')}]`
    expect(await duckdbRows(sumsSql(reader(files)))).toEqual(EXPECTED)
  })

  it('writes no file for a table a Site never synced', async () => {
    const result = await dump('parquet')

    const siteB = result.sites.find(site => site.site === SITE_B)!
    expect(siteB.datasets.map(dataset => dataset.dataset)).toEqual(['pages'])
    await expect(fs.access(path.join(outDir, 'https_b_example_', 'web', 'queries.parquet'))).rejects.toThrow()
  })

  it('adds a per-row position to row formats and keeps ISO dates', async () => {
    const result = await dump('ndjson')

    const file = result.sites[0]!.datasets.find(dataset => dataset.dataset === 'pages' && dataset.searchType === 'web')!
    const rows = (await fs.readFile(file.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows.sort((x, y) => x.date.localeCompare(y.date))).toEqual([
      { site: SITE_A, search_type: 'web', url: '/x', date: '2026-04-10', clicks: 3, impressions: 20, sum_position: 40, position: 3 },
      { site: SITE_A, search_type: 'web', url: '/x', date: '2026-04-11', clicks: 1, impressions: 10, sum_position: 0, position: 1 },
    ])
  })

  it('writes one sqlite file whose tables hold every Site and search type', async () => {
    const result = await dump('sqlite')

    expect(result.files.map(file => path.basename(file.path))).toEqual(['gscdump.sqlite'])
    const db = new DatabaseSync(path.join(outDir, 'gscdump.sqlite'))
    try {
      expect(db.prepare(sumsSql('pages').replace(' GROUP BY ALL', ' GROUP BY site, search_type').replaceAll('::INT', '')).all().map(row => ({ ...row })))
        .toEqual(EXPECTED)
      expect(db.prepare('SELECT COUNT(*) AS n, SUM(impressions) AS impressions FROM queries').get()).toEqual({ n: 1, impressions: 20 })
      expect(db.prepare('SELECT DISTINCT date FROM pages ORDER BY date').all().map(row => row.date)).toEqual(['2026-04-10', '2026-04-11'])
    }
    finally {
      db.close()
    }
  })

  it('writes one portable duckdb file with site and search_type columns', async () => {
    const result = await dump('duckdb')

    const file = path.join(outDir, 'gscdump.duckdb')
    expect(result.files.map(written => written.path)).toEqual([file])
    const instance = await DuckDBInstance.create(':memory:')
    const connection = await instance.connect()
    try {
      await connection.run(`ATTACH '${file}' AS d (READ_ONLY)`)
      expect((await connection.runAndReadAll(sumsSql('d.pages'))).getRowObjectsJS()).toEqual(EXPECTED)
      expect((await connection.runAndReadAll('SELECT typeof(date) AS t FROM d.pages LIMIT 1')).getRowObjectsJS()).toEqual([{ t: 'DATE' }])
    }
    finally {
      connection.closeSync()
      instance.closeSync()
    }
  })

  it('reports rows per dataset in manifest.json', async () => {
    await dump('csv')

    const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'))
    const siteA = manifest.sites.find((site: { site: string }) => site.site === SITE_A)
    expect(siteA.datasets).toEqual([
      { dataset: 'pages', searchType: 'image', path: 'sc_domain_a_example/image/pages.csv', rows: 1 },
      { dataset: 'pages', searchType: 'web', path: 'sc_domain_a_example/web/pages.csv', rows: 2 },
      { dataset: 'queries', searchType: 'web', path: 'sc_domain_a_example/web/queries.csv', rows: 1 },
    ])
  })

  it('keeps two Sites whose names sanitize identically in distinct files and manifest paths', async () => {
    const store = createLocalStore({ dataDir })
    const one = 'https://x.com/a-b'
    const two = 'https://x.com/a_b'
    const targets = [
      { site: one, siteId: store.siteIdFor(one) },
      { site: two, siteId: store.siteIdFor(two) },
    ]
    await store.engine.writeDay({ userId: store.userId, siteId: targets[0]!.siteId, table: 'pages', date: '2026-04-10', searchType: 'web' }, [
      { url: '/one', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 1 },
    ])
    await store.engine.writeDay({ userId: store.userId, siteId: targets[1]!.siteId, table: 'pages', date: '2026-04-10', searchType: 'web' }, [
      { url: '/two', date: '2026-04-10', clicks: 2, impressions: 20, sum_position: 2 },
    ])

    const result = await dumpSites({ store, targets, outDir, format: 'parquet', tables: new Set(['pages']) })

    const datasets = result.sites.flatMap(site => site.datasets)
    expect(new Set(datasets.map(dataset => dataset.path)).size).toBe(2)
    const rows = await duckdbRows(`SELECT site, url FROM read_parquet([${datasets.map(dataset => `'${dataset.path}'`).join(', ')}]) ORDER BY site, url`)
    expect(rows).toEqual([
      { site: one, url: '/one' },
      { site: two, url: '/two' },
    ])
    const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'))
    const paths = manifest.sites.flatMap((site: { datasets: Array<{ path: string }> }) => site.datasets.map((dataset: { path: string }) => dataset.path))
    expect(new Set(paths).size).toBe(2)
  })
})
