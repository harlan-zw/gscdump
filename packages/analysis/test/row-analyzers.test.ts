import type { QueriesRow, QueryPageRow } from '../src/types'
import { describe, expect, it } from 'vitest'
import { analyzeBrandSegmentation } from '../src/analyzers/brand'
import { analyzeCannibalization } from '../src/analyzers/cannibalization'
import { analyzeClustering } from '../src/analyzers/clustering'
import { longTailAnalyzer } from '../src/analyzers/long-tail'

describe('row analyzer reductions', () => {
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
