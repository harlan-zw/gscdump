import type { Row } from '@gscdump/engine/contracts'
import type { QueryPageRow } from '../src/types'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { runAnalyzerWithEngine } from '@gscdump/engine/source'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { analyzeUrlClusters } from '../src'
import { defaultAnalyzerRegistry } from '../src/default-registry'

const USER = 'u_test'
const SITE = 's_url_clusters'

afterAll(() => {
  resetNodeDuckDB()
})

function row(query: string, page: string, impressions: number, clicks = Math.round(impressions * 0.05), position = 4): QueryPageRow {
  return {
    query,
    page,
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position,
  }
}

describe('analyzeUrlClusters (pure)', () => {
  it('groups cross-lexical and multilingual queries by dominant ranking URL', () => {
    const rows: QueryPageRow[] = [
      // Focused Open Graph page: zero lexical overlap between "og tags" and "open graph seo"
      row('og tags', '/learn-seo/open-graph', 500, 30, 3),
      row('open graph seo', '/learn-seo/open-graph', 400, 20, 4),
      row('ogurl', '/learn-seo/open-graph', 120, 5, 5),
      // Focused social debugger page: "twitter debugger" vs "social share checker"
      row('twitter debugger', '/tools/social-share-debugger', 300, 15, 2),
      row('social share checker', '/tools/social-share-debugger', 250, 10, 3),
      // Multilingual Vue SEO page
      row('vue seo', '/learn-seo/vue', 220, 12, 3),
      row('seo mit vuejs', '/learn-seo/vue', 80, 4, 4),
      // Singleton page (< minClusterSize)
      row('unique lone topic', '/singleton', 90, 2, 6),
      // Split/cannibalized query (< 0.5 dominance share across 3 pages)
      row('generic seo', '/', 40, 1, 10),
      row('generic seo', '/learn-seo/open-graph', 35, 1, 11),
      row('generic seo', '/learn-seo/vue', 35, 1, 12),
    ]

    const out = analyzeUrlClusters(rows, { minImpressions: 10, minClusterSize: 2, minDominanceShare: 0.5 })
    expect(out.totalQueries).toBe(9)
    expect(out.clusteredQueries).toBe(7)
    expect(out.splitQueries).toBe(1)
    expect(out.unclusteredQueries).toBe(1)
    expect(out.clusters.map(c => c.url)).toEqual([
      '/learn-seo/open-graph',
      '/tools/social-share-debugger',
      '/learn-seo/vue',
    ])

    const og = out.clusters[0]!
    expect(og.leadQuery).toBe('og tags')
    expect(og.keywordCount).toBe(3)
    expect(og.totalImpressions).toBe(1020)
    expect(og.meanDominanceShare).toBe(1)
    expect(og.keywords.map(k => k.query)).toEqual(['og tags', 'open graph seo', 'ogurl'])

    const vue = out.clusters[2]!
    expect(vue.keywords.map(k => k.query)).toEqual(['vue seo', 'seo mit vuejs'])
  })

  it('extracts cross-lexical multi-URL synonym pairs and enforces numeric, polarity, direction, and short-token guards', () => {
    const rows: QueryPageRow[] = [
      // True cross-lexical pair sharing 2 specific URLs with proportional impression split
      row('og tags', '/learn-seo/open-graph', 300),
      row('og tags', '/tools/meta-tag-generator', 150),
      row('open graph seo', '/learn-seo/open-graph', 240),
      row('open graph seo', '/tools/meta-tag-generator', 120),

      // Same 2 URLs, but shares 2-char token "og" -> must NOT be emitted as zero-lexical-overlap synonym
      row('og image', '/learn-seo/open-graph', 200),
      row('og image', '/tools/meta-tag-generator', 100),

      // Numeric guard: differing version digits sharing identical URLs must NOT pair
      row('nuxt 3', '/docs/nuxt', 200),
      row('nuxt 3', '/blog/release', 100),
      row('vue 4', '/docs/nuxt', 180),
      row('vue 4', '/blog/release', 90),

      // Polarity guard: follow vs nofollow sharing identical URLs must NOT pair
      row('robots nofollow', '/docs/robots', 200),
      row('robots nofollow', '/tools/robots-tester', 100),
      row('crawler directive', '/docs/robots', 180),
      row('crawler directive', '/tools/robots-tester', 90),

      // Directional guard: directional conversion query vs zero-overlap non-directional query must NOT pair
      row('png to jpeg', '/tools/convert', 200),
      row('png to jpeg', '/guides/images', 100),
      row('raster format switcher', '/tools/convert', 180),
      row('raster format switcher', '/guides/images', 90),
    ]

    const out = analyzeUrlClusters(rows, { minImpressions: 10, minCooccurrenceCosine: 0.75 })
    const pairKeys = out.synonymPairs.map(p => `${p.queryA} <-> ${p.queryB}`)
    expect(pairKeys).toContain('og tags <-> open graph seo')
    expect(pairKeys).toContain('open graph seo <-> og image')
    // Must not pair queries sharing 2-char token "og", differing digits, polarity, or directional conversions
    expect(pairKeys).not.toContain('og tags <-> og image')
    expect(pairKeys).not.toContain('nuxt 3 <-> vue 4')
    expect(pairKeys).not.toContain('robots nofollow <-> crawler directive')
    expect(pairKeys).not.toContain('png to jpeg <-> raster format switcher')
    expect(out.synonymPairs).toHaveLength(2)
    expect(out.synonymPairs[0]).toMatchObject({
      queryA: 'og tags',
      queryB: 'open graph seo',
      sharedUrls: 2,
      combinedImpressions: 810,
      topSharedUrl: '/learn-seo/open-graph',
    })
    expect(out.synonymPairs[0]!.cosine).toBeGreaterThanOrEqual(0.99)
  })

  it('produces identical results regardless of input row order', () => {
    const rows: QueryPageRow[] = [
      row('twitter debugger', '/tools/social', 200, 10, 3),
      row('social share checker', '/tools/social', 200, 10, 3),
      row('twitter debugger', '/docs/social', 50, 2, 6),
      row('social share checker', '/docs/social', 50, 2, 6),
    ]
    const forward = analyzeUrlClusters(rows)
    const reversed = analyzeUrlClusters([...rows].reverse())
    expect(reversed).toEqual(forward)
  })

  it('skips broad hub URLs during synonym pair candidate generation and supports minImpressions=0', () => {
    const rows: QueryPageRow[] = []
    // Create 60 distinct queries all touching hub URLs /hub-a and /hub-b (df = 60 > maxHubDf = 50)
    for (let i = 0; i < 60; i++) {
      rows.push(row(`alpha${i} topic`, '/hub-a', 100))
      rows.push(row(`alpha${i} topic`, '/hub-b', 100))
    }
    const hubOnly = analyzeUrlClusters(rows, { minImpressions: 10 })
    // Both /hub-a and /hub-b exceed maxHubDf (50), so no spurious hub-only synonym pairs are generated.
    expect(hubOnly.synonymPairs).toEqual([])

    const zeroImp = analyzeUrlClusters([
      row('zero alpha', '/zero', 0, 0, 5),
      row('zero beta', '/zero', 0, 0, 6),
    ], { minImpressions: 0, minClusterSize: 2 })
    expect(zeroImp.clusters).toHaveLength(1)
    expect(zeroImp.clusters[0]!.keywordCount).toBe(2)
    expect(zeroImp.clusters[0]!.avgPosition).toBe(5.5)
  })
})

describe('url-clusters analyzer (DuckDB SQL + rows)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0))
      rmSync(d, { recursive: true, force: true })
  })

  it('runs end-to-end against DuckDB page_queries Parquet and matches row plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gscdump-url-clusters-'))
    dirs.push(dir)
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const engine = createStorageEngine({
      dataSource: createFilesystemDataSource({ rootDir: dir }),
      manifestStore: createFilesystemManifestStore({ path: join(dir, 'manifest.json') }),
      codec: createDuckDBCodec(factory),
      executor: createDuckDBExecutor(factory),
    })

    const d = '2026-04-10'
    const pageQueryRows: Row[] = [
      { url: '/learn-seo/open-graph', query: 'og tags', date: d, clicks: 30, impressions: 300, sum_position: 900 },
      { url: '/tools/meta-tag-generator', query: 'og tags', date: d, clicks: 10, impressions: 100, sum_position: 500 },
      { url: '/learn-seo/open-graph', query: 'open graph seo', date: d, clicks: 20, impressions: 240, sum_position: 960 },
      { url: '/tools/meta-tag-generator', query: 'open graph seo', date: d, clicks: 5, impressions: 80, sum_position: 480 },
      { url: '/tools/schema-validator', query: 'schema validator', date: d, clicks: 100, impressions: 1000, sum_position: 2000 },
      { url: '/tools/schema-validator', query: 'json ld checker', date: d, clicks: 40, impressions: 500, sum_position: 1500 },
      // Zero-impression cell for a qualifying query must not skew SQL vs row parity
      { url: '/unused-zero-cell', query: 'schema validator', date: d, clicks: 0, impressions: 0, sum_position: 0 },
    ]
    await engine.writeDay({ userId: USER, siteId: SITE, table: 'page_queries', date: d }, pageQueryRows)

    const sqlOut = await runAnalyzerWithEngine(
      { engine },
      { userId: USER, siteId: SITE },
      { type: 'url-clusters', startDate: d, endDate: d, minImpressions: 10, minClusterSize: 2, threshold: 0.6 },
      defaultAnalyzerRegistry,
    )

    const pagedOut = await runAnalyzerWithEngine(
      { engine },
      { userId: USER, siteId: SITE },
      { type: 'url-clusters', startDate: d, endDate: d, minImpressions: 10, minClusterSize: 2, threshold: 0.6, limit: 1, offset: 1 },
      defaultAnalyzerRegistry,
    )
    expect(pagedOut.results).toHaveLength(1)
    expect((pagedOut.results[0] as { url: string }).url).toBe('/learn-seo/open-graph')
    expect(pagedOut.meta.total).toBe(2)
    expect(pagedOut.meta.returned).toBe(1)

    const clusters = sqlOut.results as Array<{ url: string, leadQuery: string, keywordCount: number, meanDominanceShare: number }>
    expect(clusters).toHaveLength(2)
    expect(clusters[0]).toMatchObject({
      url: '/tools/schema-validator',
      leadQuery: 'schema validator',
      keywordCount: 2,
      meanDominanceShare: 1,
    })
    expect(clusters[1]).toMatchObject({
      url: '/learn-seo/open-graph',
      leadQuery: 'og tags',
      keywordCount: 2,
      meanDominanceShare: 0.75,
    })
    expect((sqlOut.meta.synonymPairs as Array<{ queryA: string, queryB: string }>)).toEqual([
      expect.objectContaining({ queryA: 'og tags', queryB: 'open graph seo', sharedUrls: 2 }),
    ])

    // Verify row-variant reducer produces identical output on the same dataset
    const rowAnalyzer = defaultAnalyzerRegistry.resolveAnalyzer('url-clusters', false)!
    const rowOut = rowAnalyzer.reduce(
      {
        rows: pageQueryRows.map(r => ({
          query: r.query,
          page: r.url,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: Number(r.impressions) > 0 ? Number(r.clicks) / Number(r.impressions) : 0,
          position: Number(r.impressions) > 0 ? Number(r.sum_position) / Number(r.impressions) + 1 : 1,
        })) as unknown as Row[],
      },
      { params: { type: 'url-clusters', startDate: d, endDate: d, minImpressions: 10, minClusterSize: 2, threshold: 0.6 } },
    )
    expect(rowOut.results).toEqual(sqlOut.results)
    expect(sqlOut.meta).toMatchObject(rowOut.meta ?? {})
  }, 30_000)
})
