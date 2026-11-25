import type { QueriesRow, QueryPageRow } from '../src/types'
import { describe, expect, it } from 'vitest'
import { analyzeBrandSegmentation } from '../src/analyzers/brand'
import { analyzeCannibalization } from '../src/analyzers/cannibalization'
import { analyzeClustering } from '../src/analyzers/clustering'
import { longTailAnalyzer } from '../src/analyzers/long-tail'
import { analyzeStrikingDistance } from '../src/analyzers/striking-distance'
import { analyzeZeroClick } from '../src/analyzers/zero-click'

describe('row analyzer reductions', () => {
  it('exposes a sorted pure striking-distance reduction', () => {
    expect(analyzeStrikingDistance([
      { query: 'first', page: '/first', clicks: 2, impressions: 200, ctr: 0.01, position: 10 },
      { query: 'second', page: '/second', clicks: 4, impressions: 100, ctr: 0.04, position: 8 },
      { query: 'excluded', page: '/excluded', clicks: 20, impressions: 500, ctr: 0.2, position: 2 },
    ])).toEqual([
      expect.objectContaining({ keyword: 'first', potentialClicks: 30 }),
      expect.objectContaining({ keyword: 'second', potentialClicks: 15 }),
    ])
  })

  it('accumulates brand summary metrics while partitioning rows', () => {
    const rows: QueriesRow[] = [
      { query: 'Acme pricing', clicks: 8, impressions: 80, ctr: 0.1, position: 2 },
      { query: 'generic pricing', clicks: 2, impressions: 20, ctr: 0.1, position: 4 },
      { query: 'acme ignored', clicks: 10, impressions: 5, ctr: 2, position: 1 },
    ]
    const result = analyzeBrandSegmentation(rows, { brandTerms: ['acme'], minImpressions: 10 })

    expect(result.brand.map(row => row.query)).toEqual(['Acme pricing'])
    expect(result.nonBrand.map(row => row.query)).toEqual(['generic pricing'])
    expect(result.summary).toEqual({
      brandClicks: 8,
      nonBrandClicks: 2,
      brandShare: 0.8,
      brandImpressions: 80,
      nonBrandImpressions: 20,
    })
  })

  it('uses raw query variants when segmenting a canonical keyword', () => {
    const rows = [{
      keyword: 'pricing',
      variants: ['Acme pricing', 'pricing'],
      clicks: 5,
      impressions: 50,
    }]
    const result = analyzeBrandSegmentation(rows, { brandTerms: ['acme'] })
    expect(result.brand).toEqual(rows)
  })

  it('aggregates clustering metrics in one pass with weighted position', () => {
    const rows: QueriesRow[] = [
      { query: 'topic alpha one', clicks: 2, impressions: 10, ctr: 0.2, position: 1 },
      { query: 'topic alpha two', clicks: 3, impressions: 30, ctr: 0.1, position: 5 },
      { query: 'different words only', clicks: 1, impressions: 20, ctr: 0.05, position: 3 },
    ]
    const result = analyzeClustering(rows, { clusterBy: 'prefix' })

    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0]).toMatchObject({
      clusterName: 'topic alpha',
      totalClicks: 5,
      totalImpressions: 40,
      avgPosition: 4,
      keywordCount: 2,
    })
    expect(result.unclustered.map(row => row.query)).toEqual(['different words only'])
  })

  it('includes 2-word head queries in their matching 2-word prefix cluster', () => {
    const rows: QueriesRow[] = [
      { query: 'schema validator', clicks: 20, impressions: 1000, ctr: 0.02, position: 3 },
      { query: 'schema validator online', clicks: 5, impressions: 100, ctr: 0.05, position: 4 },
      { query: 'solo', clicks: 1, impressions: 50, ctr: 0.02, position: 2 },
    ]
    const result = analyzeClustering(rows, { clusterBy: 'prefix' })

    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0]).toMatchObject({
      clusterName: 'schema validator',
      clusterType: 'prefix',
      keywordCount: 2,
      totalImpressions: 1100,
    })
    expect(result.unclustered.map(row => row.query)).toEqual(['solo'])
  })

  it('requires a word boundary before matching an intent prefix', () => {
    const rows: QueriesRow[] = [
      { query: 'topic alpha one', clicks: 2, impressions: 20, ctr: 0.1, position: 2 },
      { query: 'topic alpha two', clicks: 3, impressions: 30, ctr: 0.1, position: 3 },
      { query: 'top widgets', clicks: 4, impressions: 40, ctr: 0.1, position: 1 },
      { query: 'top gadgets', clicks: 5, impressions: 50, ctr: 0.1, position: 2 },
    ]
    const result = analyzeClustering(rows, { clusterBy: 'both' })

    expect(result.clusters.find(c => c.clusterName === 'top')?.keywords.map(k => k.query).sort()).toEqual(['top gadgets', 'top widgets'])
    expect(result.clusters.find(c => c.clusterName === 'topic alpha')).toMatchObject({
      clusterType: 'prefix',
      keywordCount: 2,
    })
  })

  it('matches exact intent-only queries and whitespace-separated intent prefixes', () => {
    const rows: QueriesRow[] = [
      { query: '  top  ', clicks: 2, impressions: 20, ctr: 0.1, position: 2 },
      { query: 'top\twidgets', clicks: 3, impressions: 30, ctr: 0.1, position: 3 },
      { query: '\tsolo\n', clicks: 1, impressions: 40, ctr: 0.025, position: 4 },
    ]
    const result = analyzeClustering(rows, { clusterBy: 'both' })

    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0]).toMatchObject({
      clusterName: 'top',
      clusterType: 'intent',
      keywordCount: 2,
    })
    expect(result.unclustered.map(row => row.query)).toEqual(['\tsolo\n'])
  })

  it('groups canonical query variants when canonical mode is enabled', () => {
    const rows: QueriesRow[] = [
      { query: 'schema validator', clicks: 40, impressions: 1000, ctr: 0.04, position: 2 },
      { query: 'schema checker', clicks: 20, impressions: 400, ctr: 0.05, position: 3 },
      { query: 'free schema tester online', clicks: 5, impressions: 100, ctr: 0.05, position: 4 },
      { query: 'nuxt sitemap guide', clicks: 3, impressions: 60, ctr: 0.05, position: 5 },
      { query: 'nuxt sitemap setup', clicks: 2, impressions: 40, ctr: 0.05, position: 6 },
      { query: 'best standalone orphan', clicks: 1, impressions: 30, ctr: 0.03, position: 7 },
    ]
    const result = analyzeClustering(rows, { canonical: true })

    expect(result.clusters.find(c => c.clusterType === 'canonical')).toMatchObject({
      clusterName: 'schema validator',
      keywordCount: 3,
      totalImpressions: 1500,
    })
    expect(result.clusters.find(c => c.clusterName === 'nuxt sitemap')).toMatchObject({
      clusterType: 'prefix',
      keywordCount: 2,
    })
    // Singleton intent query must not vanish from unclustered.
    expect(result.unclustered.map(k => k.query)).toEqual(['best standalone orphan'])
  })

  it('folds free-prefixed variant with base query under default clusterBy=both', () => {
    const rows: QueriesRow[] = [
      { query: 'schema validator', clicks: 10, impressions: 200, ctr: 0.05, position: 2 },
      { query: 'free schema validator', clicks: 5, impressions: 100, ctr: 0.05, position: 3 },
    ]
    const result = analyzeClustering(rows, { canonical: true })

    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0]).toMatchObject({
      clusterName: 'schema validator',
      clusterType: 'canonical',
      keywordCount: 2,
      totalImpressions: 300,
    })
    expect(result.unclustered).toEqual([])
  })

  it('computes cannibalization totals and spread before sorting qualifying pages', () => {
    const rows: QueryPageRow[] = [
      { query: 'shared', page: '/a', clicks: 2, impressions: 20, ctr: 0.1, position: 5 },
      { query: 'shared', page: '/b', clicks: 8, impressions: 80, ctr: 0.1, position: 2 },
      { query: 'too-wide', page: '/c', clicks: 5, impressions: 50, ctr: 0.1, position: 1 },
      { query: 'too-wide', page: '/d', clicks: 5, impressions: 50, ctr: 0.1, position: 20 },
    ]
    const result = analyzeCannibalization(rows)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      query: 'shared',
      totalClicks: 10,
      totalImpressions: 100,
      positionSpread: 3,
    })
    expect(result[0]?.pages.map(page => page.page)).toEqual(['/b', '/a'])
  })

  it('folds canonical variants before detecting row-level cannibalization when canonical is enabled', () => {
    const rows: QueryPageRow[] = [
      { query: 'schema validator', page: '/tools/schema', clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
      { query: 'schema checker', page: '/docs/schema', clicks: 4, impressions: 80, ctr: 0.05, position: 5 },
      { query: 'free schema tester online', page: '/docs/schema', clicks: 1, impressions: 20, ctr: 0.05, position: 6 },
    ]
    expect(analyzeCannibalization(rows)).toEqual([])

    const canonical = analyzeCannibalization(rows, { canonical: true })
    expect(canonical).toHaveLength(1)
    expect(canonical[0]).toMatchObject({
      query: 'schema validator',
      canonicalKey: 'schema validator',
      totalClicks: 15,
      totalImpressions: 200,
      variants: ['schema validator', 'schema checker', 'free schema tester online'],
    })
    expect(canonical[0]?.pages.map(p => p.page)).toEqual(['/tools/schema', '/docs/schema'])
  })

  it('excludes sub-threshold URL variants from canonical cannibalization headline and variants', () => {
    const rows: QueryPageRow[] = [
      { query: 'schema validator', page: '/a', clicks: 6, impressions: 60, ctr: 0.1, position: 3 },
      { query: 'schema validator', page: '/b', clicks: 5, impressions: 55, ctr: 0.09, position: 4 },
      { query: 'schema checker', page: '/c', clicks: 2, impressions: 40, ctr: 0.05, position: 5 },
      { query: 'schema checker', page: '/d', clicks: 2, impressions: 40, ctr: 0.05, position: 5 },
      { query: 'schema checker', page: '/e', clicks: 2, impressions: 40, ctr: 0.05, position: 5 },
    ]
    const canonical = analyzeCannibalization(rows, { canonical: true, minImpressions: 50 })
    expect(canonical).toHaveLength(1)
    expect(canonical[0]).toMatchObject({
      query: 'schema validator',
      canonicalKey: 'schema validator',
      variants: ['schema validator'],
    })
  })

  it('keeps the best-positioned page for each zero-click query', () => {
    const rows: QueryPageRow[] = [
      { query: 'answer', page: '/weak', clicks: 1, impressions: 1200, ctr: 0.001, position: 8 },
      { query: 'answer', page: '/best', clicks: 2, impressions: 1100, ctr: 0.002, position: 3 },
    ]
    expect(analyzeZeroClick(rows)).toEqual([rows[1]])
  })

  it('downsamples long-tail points without changing the log-rank selection', () => {
    const points = Array.from({ length: 200 }, (_, i) => ({
      rank: i + 1,
      impressions: 200 - i,
      clicks: i % 10,
      query: `query-${i + 1}`,
    }))
    const reduced = longTailAnalyzer.sql!.reduce([{
      page: '/page',
      queryCount: 200,
      totalImpressions: 20_100,
      totalClicks: 900,
      slope: -1,
      intercept: 5,
      r2: 0.9,
      headImpressions: 200,
      headShare: 0.01,
      fingerprint: 'balanced',
      pointsJson: JSON.stringify(points),
    }], { params: { type: 'long-tail', startDate: '2026-01-01', endDate: '2026-01-31' } })
    const sampled = reduced.results as Array<{ points: Array<{ rank: number, query: string }> }>

    expect(sampled[0]?.points.length).toBeLessThan(80)
    expect(sampled[0]?.points.slice(0, 10).map(point => point.rank)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
    ])
    expect(sampled[0]?.points.at(-1)?.query).toMatch(/^query-/)
  })
})
