import type { GoogleSearchConsoleClient } from '../src'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeBrandSegmentation,
  analyzeQueryClustering,
  analyzeTrafficConcentration,
  analyzeSeasonality,
  analyzeOpportunityScore,
} from '../src'

const mockQuery = vi.fn()
const mockClient = {
  searchAnalytics: {
    query: mockQuery,
  },
} as unknown as GoogleSearchConsoleClient

const mockSite = 'https://example.com/'

describe('analyzeBrandSegmentation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should separate brand and non-brand keywords', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['acme widgets'], clicks: 500, impressions: 5000, ctr: 0.1, position: 1 },
        { keys: ['acme company'], clicks: 300, impressions: 3000, ctr: 0.1, position: 2 },
        { keys: ['best widgets'], clicks: 200, impressions: 4000, ctr: 0.05, position: 5 },
        { keys: ['buy widgets online'], clicks: 100, impressions: 2000, ctr: 0.05, position: 8 },
      ],
    })

    const result = await analyzeBrandSegmentation(mockClient, mockSite, {
      brandTerms: ['acme'],
    })

    expect(result.brand).toHaveLength(2)
    expect(result.nonBrand).toHaveLength(2)
    expect(result.summary.brandClicks).toBe(800)
    expect(result.summary.nonBrandClicks).toBe(300)
    expect(result.summary.brandShare).toBeCloseTo(0.727, 2)
  })

  it('should handle case-insensitive matching', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['ACME Products'], clicks: 100, impressions: 1000, ctr: 0.1, position: 1 },
        { keys: ['Acme Store'], clicks: 100, impressions: 1000, ctr: 0.1, position: 2 },
      ],
    })

    const result = await analyzeBrandSegmentation(mockClient, mockSite, {
      brandTerms: ['acme'],
    })

    expect(result.brand).toHaveLength(2)
    expect(result.nonBrand).toHaveLength(0)
  })

  it('should handle multiple brand terms', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['acme widgets'], clicks: 100, impressions: 1000, ctr: 0.1, position: 1 },
        { keys: ['superco products'], clicks: 100, impressions: 1000, ctr: 0.1, position: 2 },
        { keys: ['generic widgets'], clicks: 100, impressions: 1000, ctr: 0.1, position: 3 },
      ],
    })

    const result = await analyzeBrandSegmentation(mockClient, mockSite, {
      brandTerms: ['acme', 'superco'],
    })

    expect(result.brand).toHaveLength(2)
    expect(result.nonBrand).toHaveLength(1)
  })

  it('should filter by minImpressions', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['acme'], clicks: 1, impressions: 5, ctr: 0.2, position: 1 },
        { keys: ['generic'], clicks: 1, impressions: 5, ctr: 0.2, position: 2 },
      ],
    })

    const result = await analyzeBrandSegmentation(mockClient, mockSite, {
      brandTerms: ['acme'],
      minImpressions: 10,
    })

    expect(result.brand).toHaveLength(0)
    expect(result.nonBrand).toHaveLength(0)
  })

  it('should handle empty results', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await analyzeBrandSegmentation(mockClient, mockSite, {
      brandTerms: ['acme'],
    })

    expect(result.brand).toHaveLength(0)
    expect(result.nonBrand).toHaveLength(0)
    expect(result.summary.brandShare).toBe(0)
  })
})

describe('analyzeQueryClustering', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should cluster by intent prefixes', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['how to make widgets'], clicks: 100, impressions: 1000, ctr: 0.1, position: 3 },
        { keys: ['how to fix widgets'], clicks: 80, impressions: 800, ctr: 0.1, position: 4 },
        { keys: ['best widget brands'], clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
        { keys: ['best widget prices'], clicks: 40, impressions: 400, ctr: 0.1, position: 6 },
      ],
    })

    const result = await analyzeQueryClustering(mockClient, mockSite, {
      clusterBy: 'intent',
    })

    const howToCluster = result.clusters.find(c => c.clusterName === 'how to')
    const bestCluster = result.clusters.find(c => c.clusterName === 'best')

    expect(howToCluster).toBeDefined()
    expect(howToCluster?.keywords).toHaveLength(2)
    expect(howToCluster?.totalClicks).toBe(180)

    expect(bestCluster).toBeDefined()
    expect(bestCluster?.keywords).toHaveLength(2)
  })

  it('should cluster by common prefixes', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['widget repair service'], clicks: 100, impressions: 1000, ctr: 0.1, position: 3 },
        { keys: ['widget repair cost'], clicks: 80, impressions: 800, ctr: 0.1, position: 4 },
        { keys: ['widget repair near me'], clicks: 60, impressions: 600, ctr: 0.1, position: 5 },
      ],
    })

    const result = await analyzeQueryClustering(mockClient, mockSite, {
      clusterBy: 'prefix',
    })

    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0].clusterName).toBe('widget repair')
    expect(result.clusters[0].keywords).toHaveLength(3)
  })

  it('should respect minClusterSize', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['random phrase one'], clicks: 100, impressions: 1000, ctr: 0.1, position: 3 },
        { keys: ['another unrelated term'], clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
      ],
    })

    const result = await analyzeQueryClustering(mockClient, mockSite, {
      minClusterSize: 2,
    })

    expect(result.clusters).toHaveLength(0)
    expect(result.unclustered).toHaveLength(2)
  })

  it('should calculate cluster metrics correctly', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['what is widget'], clicks: 100, impressions: 1000, ctr: 0.1, position: 2 },
        { keys: ['what is gadget'], clicks: 50, impressions: 500, ctr: 0.1, position: 4 },
      ],
    })

    const result = await analyzeQueryClustering(mockClient, mockSite, {
      clusterBy: 'intent',
    })

    const whatIsCluster = result.clusters.find(c => c.clusterName === 'what is')
    expect(whatIsCluster?.totalClicks).toBe(150)
    expect(whatIsCluster?.totalImpressions).toBe(1500)
    expect(whatIsCluster?.avgPosition).toBe(3) // (2+4)/2
    expect(whatIsCluster?.keywordCount).toBe(2)
  })

  it('should handle empty results', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await analyzeQueryClustering(mockClient, mockSite)

    expect(result.clusters).toHaveLength(0)
    expect(result.unclustered).toHaveLength(0)
  })
})

describe('analyzeTrafficConcentration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should calculate concentration metrics for pages', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['/page-1'], clicks: 1000, impressions: 10000, ctr: 0.1, position: 1 },
        { keys: ['/page-2'], clicks: 500, impressions: 5000, ctr: 0.1, position: 2 },
        { keys: ['/page-3'], clicks: 300, impressions: 3000, ctr: 0.1, position: 3 },
        { keys: ['/page-4'], clicks: 200, impressions: 2000, ctr: 0.1, position: 4 },
      ],
    })

    const result = await analyzeTrafficConcentration(mockClient, mockSite, {
      dimension: 'page',
    })

    expect(result.totalItems).toBe(4)
    expect(result.totalClicks).toBe(2000)
    expect(result.giniCoefficient).toBeGreaterThan(0)
    expect(result.giniCoefficient).toBeLessThan(1)
    expect(result.hhi).toBeGreaterThan(0)
    expect(result.topNItems).toHaveLength(4)
    expect(result.topNItems[0].key).toBe('/page-1')
    expect(result.topNItems[0].share).toBe(0.5)
  })

  it('should detect high concentration (single dominant page)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['/dominant'], clicks: 9000, impressions: 90000, ctr: 0.1, position: 1 },
        { keys: ['/minor-1'], clicks: 500, impressions: 5000, ctr: 0.1, position: 5 },
        { keys: ['/minor-2'], clicks: 500, impressions: 5000, ctr: 0.1, position: 6 },
      ],
    })

    const result = await analyzeTrafficConcentration(mockClient, mockSite)

    expect(result.riskLevel).toBe('high')
    expect(result.hhi).toBeGreaterThan(2500)
  })

  it('should detect low concentration (even distribution)', async () => {
    // HHI for n equal items = 10000/n. Need n > ~7 for low (<1500)
    mockQuery.mockResolvedValue({
      rows: Array.from({ length: 10 }, (_, i) => ({
        keys: [`/page-${i + 1}`],
        clicks: 100,
        impressions: 1000,
        ctr: 0.1,
        position: i + 1,
      })),
    })

    const result = await analyzeTrafficConcentration(mockClient, mockSite)

    expect(result.riskLevel).toBe('low')
    expect(result.hhi).toBeLessThan(1500)
  })

  it('should calculate topN concentration correctly', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['/page-1'], clicks: 500, impressions: 5000, ctr: 0.1, position: 1 },
        { keys: ['/page-2'], clicks: 300, impressions: 3000, ctr: 0.1, position: 2 },
        { keys: ['/page-3'], clicks: 200, impressions: 2000, ctr: 0.1, position: 3 },
      ],
    })

    const result = await analyzeTrafficConcentration(mockClient, mockSite, { topN: 2 })

    // Top 2 = 800/1000 = 0.8
    expect(result.topNConcentration).toBe(0.8)
  })

  it('should work with keyword dimension', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['keyword-1'], clicks: 1000, impressions: 10000, ctr: 0.1, position: 1 },
        { keys: ['keyword-2'], clicks: 500, impressions: 5000, ctr: 0.1, position: 2 },
      ],
    })

    const result = await analyzeTrafficConcentration(mockClient, mockSite, {
      dimension: 'keyword',
    })

    expect(result.totalItems).toBe(2)
    expect(result.topNItems[0].key).toBe('keyword-1')
  })

  it('should handle empty results', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await analyzeTrafficConcentration(mockClient, mockSite)

    expect(result.totalItems).toBe(0)
    expect(result.totalClicks).toBe(0)
    expect(result.giniCoefficient).toBe(0)
    expect(result.hhi).toBe(0)
  })
})

describe('analyzeSeasonality', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should detect seasonality with peaks and troughs', async () => {
    // Simulate monthly data with clear Dec peak and June trough
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['2025-01-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-02-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-03-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-04-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-05-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-06-15'], clicks: 30, impressions: 300, ctr: 0.1, position: 5 }, // trough
        { keys: ['2025-07-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-08-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-09-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-10-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-11-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-12-15'], clicks: 250, impressions: 2500, ctr: 0.1, position: 5 }, // peak
      ],
    })

    const result = await analyzeSeasonality(mockClient, mockSite, {
      period: { start: '2025-01-01', end: '2025-12-31' },
    })

    expect(result.hasSeasonality).toBe(true)
    expect(result.peakMonths).toContain('12')
    expect(result.troughMonths).toContain('06')
    expect(result.monthlyBreakdown).toHaveLength(12)
    expect(result.insufficientData).toBe(false)
  })

  it('should detect no seasonality with stable traffic', async () => {
    mockQuery.mockResolvedValue({
      rows: Array.from({ length: 12 }, (_, i) => ({
        keys: [`2025-${String(i + 1).padStart(2, '0')}-15`],
        clicks: 100,
        impressions: 1000,
        ctr: 0.1,
        position: 5,
      })),
    })

    const result = await analyzeSeasonality(mockClient, mockSite, {
      period: { start: '2025-01-01', end: '2025-12-31' },
    })

    expect(result.hasSeasonality).toBe(false)
    expect(result.peakMonths).toHaveLength(0)
    expect(result.troughMonths).toHaveLength(0)
  })

  it('should flag insufficient data for short periods', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['2025-01-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-02-15'], clicks: 200, impressions: 2000, ctr: 0.1, position: 5 },
        { keys: ['2025-03-15'], clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
      ],
    })

    const result = await analyzeSeasonality(mockClient, mockSite, {
      period: { start: '2025-01-01', end: '2025-03-31' },
    })

    expect(result.insufficientData).toBe(true)
  })

  it('should calculate strength as coefficient of variation', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['2025-01-15'], clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
        { keys: ['2025-02-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-03-15'], clicks: 150, impressions: 1500, ctr: 0.1, position: 5 },
        { keys: ['2025-04-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-05-15'], clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
        { keys: ['2025-06-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-07-15'], clicks: 150, impressions: 1500, ctr: 0.1, position: 5 },
        { keys: ['2025-08-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-09-15'], clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
        { keys: ['2025-10-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        { keys: ['2025-11-15'], clicks: 150, impressions: 1500, ctr: 0.1, position: 5 },
        { keys: ['2025-12-15'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
      ],
    })

    const result = await analyzeSeasonality(mockClient, mockSite, {
      period: { start: '2025-01-01', end: '2025-12-31' },
    })

    expect(result.strength).toBeGreaterThan(0)
    expect(result.strength).toBeLessThanOrEqual(1)
  })

  it('should handle empty results', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await analyzeSeasonality(mockClient, mockSite)

    expect(result.hasSeasonality).toBe(false)
    expect(result.insufficientData).toBe(true)
    expect(result.monthlyBreakdown).toHaveLength(0)
  })
})

describe('analyzeOpportunityScore', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should score keywords in striking distance higher', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          // Position 8 with high impressions - good opportunity
          { keys: ['opportunity query'], clicks: 50, impressions: 5000, ctr: 0.01, position: 8 },
          // Position 1 - already ranking well
          { keys: ['top query'], clicks: 500, impressions: 5000, ctr: 0.1, position: 1 },
          // Position 50 - too far to optimize
          { keys: ['far query'], clicks: 10, impressions: 5000, ctr: 0.002, position: 50 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['opportunity query', '/target-page'], clicks: 50, impressions: 5000 },
          { keys: ['top query', '/home'], clicks: 500, impressions: 5000 },
          { keys: ['far query', '/blog'], clicks: 10, impressions: 5000 },
        ],
      })

    const results = await analyzeOpportunityScore(mockClient, mockSite)

    expect(results).toHaveLength(3)
    // Opportunity query should score highest
    expect(results[0].query).toBe('opportunity query')
    expect(results[0].opportunityScore).toBeGreaterThan(results[1].opportunityScore)
  })

  it('should calculate potential clicks based on improved CTR', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['test query'], clicks: 100, impressions: 10000, ctr: 0.01, position: 8 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['test query', '/page'], clicks: 100, impressions: 10000 },
        ],
      })

    const results = await analyzeOpportunityScore(mockClient, mockSite)

    expect(results[0].potentialClicks).toBeGreaterThan(results[0].clicks)
  })

  it('should filter by minImpressions', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['low-volume'], clicks: 1, impressions: 10, ctr: 0.1, position: 8 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    const results = await analyzeOpportunityScore(mockClient, mockSite, {
      minImpressions: 100,
    })

    expect(results).toHaveLength(0)
  })

  it('should include factor breakdown', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['test'], clicks: 100, impressions: 1000, ctr: 0.1, position: 10 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['test', '/page'], clicks: 100, impressions: 1000 },
        ],
      })

    const results = await analyzeOpportunityScore(mockClient, mockSite)

    expect(results[0].factors).toHaveProperty('positionScore')
    expect(results[0].factors).toHaveProperty('impressionScore')
    expect(results[0].factors).toHaveProperty('ctrGapScore')
  })

  it('should support custom weights', async () => {
    // CTR of 0.005 is below expected ~0.015 at position 10, creating opportunity
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['test'], clicks: 5, impressions: 1000, ctr: 0.005, position: 10 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    const withDefaultWeights = await analyzeOpportunityScore(mockClient, mockSite)

    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['test'], clicks: 5, impressions: 1000, ctr: 0.005, position: 10 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    // Increase position weight significantly
    const withModifiedWeights = await analyzeOpportunityScore(mockClient, mockSite, {
      weights: { position: 5, impressions: 1, ctrGap: 1 },
    })

    // Scores should differ when weights change
    expect(withDefaultWeights[0].opportunityScore).not.toBe(withModifiedWeights[0].opportunityScore)
  })

  it('should sort by different metrics', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['high-potential'], clicks: 50, impressions: 10000, ctr: 0.005, position: 8 },
          { keys: ['high-impressions'], clicks: 100, impressions: 20000, ctr: 0.005, position: 15 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    const byPotential = await analyzeOpportunityScore(mockClient, mockSite, {
      sortBy: 'potentialClicks',
    })

    expect(byPotential[0].potentialClicks).toBeGreaterThanOrEqual(byPotential[1].potentialClicks)
  })

  it('should handle empty results', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const results = await analyzeOpportunityScore(mockClient, mockSite)

    expect(results).toHaveLength(0)
  })
})
