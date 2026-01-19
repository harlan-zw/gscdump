import type { GoogleSearchConsoleClient } from '../src'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeCannibalization, analyzeContentDecay, analyzeMoversAndShakers, analyzeStrikingDistance, analyzeZeroClickQueries, between, date, fetchYoYComparison, gsc } from '../src'

const mockQuery = vi.fn()
const mockClient = {
  searchAnalytics: {
    query: mockQuery,
  },
} as unknown as GoogleSearchConsoleClient

const mockSite = 'https://example.com/'

describe('analyzeCannibalization', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should detect queries ranking for multiple pages', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['test query', '/page-1'], clicks: 100, impressions: 1000, ctr: 0.1, position: 3 },
        { keys: ['test query', '/page-2'], clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
        { keys: ['unique query', '/page-3'], clicks: 200, impressions: 2000, ctr: 0.1, position: 2 },
      ],
    })

    const results = await analyzeCannibalization(mockClient, mockSite)

    expect(results).toHaveLength(1)
    expect(results[0].query).toBe('test query')
    expect(results[0].pages).toHaveLength(2)
    expect(results[0].totalClicks).toBe(150)
    expect(results[0].totalImpressions).toBe(1500)
    expect(results[0].positionSpread).toBe(2)
  })

  it('should filter by minImpressions', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['query', '/page-1'], clicks: 10, impressions: 50, ctr: 0.2, position: 3 },
        { keys: ['query', '/page-2'], clicks: 5, impressions: 25, ctr: 0.2, position: 5 },
      ],
    })

    const results = await analyzeCannibalization(mockClient, mockSite, { minImpressions: 100 })

    expect(results).toHaveLength(0)
  })

  it('should filter by maxPositionSpread', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['query', '/page-1'], clicks: 100, impressions: 1000, ctr: 0.1, position: 1 },
        { keys: ['query', '/page-2'], clicks: 50, impressions: 500, ctr: 0.1, position: 50 },
      ],
    })

    const results = await analyzeCannibalization(mockClient, mockSite, { maxPositionSpread: 10 })

    expect(results).toHaveLength(0)
  })

  it('should sort by different metrics', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['query-a', '/page-1'], clicks: 50, impressions: 2000, ctr: 0.025, position: 3 },
        { keys: ['query-a', '/page-2'], clicks: 25, impressions: 1000, ctr: 0.025, position: 5 },
        { keys: ['query-b', '/page-3'], clicks: 200, impressions: 500, ctr: 0.4, position: 2 },
        { keys: ['query-b', '/page-4'], clicks: 100, impressions: 250, ctr: 0.4, position: 4 },
      ],
    })

    // Sort by clicks (default)
    const byClicks = await analyzeCannibalization(mockClient, mockSite, { sortBy: 'clicks' })
    expect(byClicks[0].query).toBe('query-b')

    // Sort by impressions
    const byImpressions = await analyzeCannibalization(mockClient, mockSite, { sortBy: 'impressions' })
    expect(byImpressions[0].query).toBe('query-a')

    // Sort by positionSpread ascending
    const bySpread = await analyzeCannibalization(mockClient, mockSite, { sortBy: 'positionSpread', sortOrder: 'asc' })
    expect(bySpread[0].positionSpread).toBeLessThanOrEqual(bySpread[1].positionSpread)
  })

  it('should handle empty results', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const results = await analyzeCannibalization(mockClient, mockSite)

    expect(results).toHaveLength(0)
  })
})

describe('analyzeStrikingDistance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should find keywords in striking distance', async () => {
    // First call for query data, second for query+page data
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['striking query'], clicks: 10, impressions: 1000, ctr: 0.01, position: 8 },
          { keys: ['top query'], clicks: 500, impressions: 2000, ctr: 0.25, position: 2 },
          { keys: ['low volume'], clicks: 1, impressions: 50, ctr: 0.02, position: 10 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['striking query', '/target-page'], clicks: 10, impressions: 1000 },
          { keys: ['top query', '/home'], clicks: 500, impressions: 2000 },
        ],
      })

    const results = await analyzeStrikingDistance(mockClient, mockSite)

    expect(results).toHaveLength(1)
    expect(results[0].query).toBe('striking query')
    expect(results[0].page).toBe('/target-page')
    expect(results[0].potentialClicks).toBe(150) // 1000 * 0.15
  })

  it('should filter by position range', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['pos-3'], clicks: 100, impressions: 1000, ctr: 0.01, position: 3 },
          { keys: ['pos-10'], clicks: 50, impressions: 1000, ctr: 0.01, position: 10 },
          { keys: ['pos-25'], clicks: 25, impressions: 1000, ctr: 0.01, position: 25 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    const results = await analyzeStrikingDistance(mockClient, mockSite, {
      minPosition: 4,
      maxPosition: 20,
    })

    expect(results).toHaveLength(1)
    expect(results[0].position).toBe(10)
  })

  it('should filter by maxCtr', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['high-ctr'], clicks: 100, impressions: 500, ctr: 0.2, position: 8 },
          { keys: ['low-ctr'], clicks: 10, impressions: 500, ctr: 0.02, position: 8 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    const results = await analyzeStrikingDistance(mockClient, mockSite, { maxCtr: 0.05 })

    expect(results).toHaveLength(1)
    expect(results[0].query).toBe('low-ctr')
  })

  it('should sort by different metrics', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['query-a'], clicks: 50, impressions: 2000, ctr: 0.025, position: 8 },
          { keys: ['query-b'], clicks: 100, impressions: 1000, ctr: 0.01, position: 10 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    // Sort by impressions
    const byImpressions = await analyzeStrikingDistance(mockClient, mockSite, { sortBy: 'impressions' })
    expect(byImpressions[0].query).toBe('query-a')

    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['query-a'], clicks: 50, impressions: 2000, ctr: 0.025, position: 8 },
          { keys: ['query-b'], clicks: 100, impressions: 1000, ctr: 0.01, position: 10 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    // Sort by position ascending (closer to page 1)
    const byPosition = await analyzeStrikingDistance(mockClient, mockSite, { sortBy: 'position', sortOrder: 'asc' })
    expect(byPosition[0].query).toBe('query-a')
  })
})

describe('fetchYoYComparison', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should compare current vs previous year metrics', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['2026-01-01'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
          { keys: ['2026-01-02'], clicks: 120, impressions: 1200, ctr: 0.1, position: 4.5 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['2025-01-01'], clicks: 80, impressions: 800, ctr: 0.1, position: 6 },
          { keys: ['2025-01-02'], clicks: 90, impressions: 900, ctr: 0.1, position: 5.5 },
        ],
      })

    // Use dates within GSC's 16-month limit (current year vs last year)
    const result = await fetchYoYComparison(mockClient, mockSite, {
      period: { start: new Date('2026-01-01'), end: new Date('2026-01-02') },
    })

    expect(result.current.clicks).toBe(220)
    expect(result.previous.clicks).toBe(170)
    expect(result.change.clicks).toBe(50)
    expect(result.periodDays).toBe(1)
  })

  it('should handle empty previous year data', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ keys: ['2026-01-01'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const result = await fetchYoYComparison(mockClient, mockSite, {
      period: { start: new Date('2026-01-01'), end: new Date('2026-01-02') },
    })

    expect(result.current.clicks).toBe(100)
    expect(result.previous.clicks).toBe(0)
  })

  it('should indicate when outside GSC limit', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await fetchYoYComparison(mockClient, mockSite)

    expect(result).toHaveProperty('withinLimit')
    expect(typeof result.withinLimit).toBe('boolean')
  })
})

describe('analyzeMoversAndShakers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should categorize rising, declining, and stable queries', async () => {
    // Recent query data (7 days)
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['rising'], clicks: 100, impressions: 500, position: 5 },
          { keys: ['declining'], clicks: 20, impressions: 500, position: 8 },
          { keys: ['stable'], clicks: 50, impressions: 500, position: 6 },
        ],
      })
      // Baseline query data (28 days, so divide by 4 for normalization)
      .mockResolvedValueOnce({
        rows: [
          { keys: ['rising'], clicks: 100, impressions: 1000, position: 7 }, // 25 normalized
          { keys: ['declining'], clicks: 400, impressions: 2000, position: 5 }, // 100 normalized
          { keys: ['stable'], clicks: 200, impressions: 2000, position: 6 }, // 50 normalized
        ],
      })
      // Recent pages
      .mockResolvedValueOnce({
        rows: [
          { keys: ['rising', '/page-1'] },
          { keys: ['declining', '/page-2'] },
          { keys: ['stable', '/page-3'] },
        ],
      })
      // Baseline pages
      .mockResolvedValueOnce({ rows: [] })

    const result = await analyzeMoversAndShakers(mockClient, mockSite, { minImpressions: 100 })

    expect(result.rising.length).toBeGreaterThan(0)
    expect(result.declining.length).toBeGreaterThan(0)
    expect(result.rising[0].query).toBe('rising')
    expect(result.declining[0].query).toBe('declining')
  })

  it('should filter by minImpressions', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['low-impressions'], clicks: 10, impressions: 20, position: 5 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await analyzeMoversAndShakers(mockClient, mockSite, { minImpressions: 100 })

    expect(result.rising).toHaveLength(0)
    expect(result.declining).toHaveLength(0)
    expect(result.stable).toHaveLength(0)
  })

  it('should respect changeThreshold', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['small-change'], clicks: 55, impressions: 500, position: 5 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['small-change'], clicks: 200, impressions: 2000, position: 5 }, // 50/week avg
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    // 55 vs 50 = ~10% change, below 20% threshold
    const result = await analyzeMoversAndShakers(mockClient, mockSite, { changeThreshold: 0.2 })

    expect(result.stable.length).toBe(1)
    expect(result.rising).toHaveLength(0)
    expect(result.declining).toHaveLength(0)
  })

  it('should sort by different metrics', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['query-a'], clicks: 200, impressions: 500, position: 5 },
          { keys: ['query-b'], clicks: 100, impressions: 1000, position: 3 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['query-a'], clicks: 100, impressions: 1000, position: 8 },
          { keys: ['query-b'], clicks: 40, impressions: 2000, position: 6 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const byClicks = await analyzeMoversAndShakers(mockClient, mockSite, { sortBy: 'clicks' })

    // Both should be rising, sorted by recent clicks
    expect(byClicks.rising[0].recentClicks).toBeGreaterThanOrEqual(byClicks.rising[1]?.recentClicks || 0)
  })

  it('should return period metadata', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await analyzeMoversAndShakers(mockClient, mockSite)

    expect(result.periods).toHaveProperty('recent')
    expect(result.periods).toHaveProperty('baseline')
    expect(result.periods.recent).toHaveProperty('start')
    expect(result.periods.recent).toHaveProperty('end')
  })

  it('should accept custom query and compareQuery', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await analyzeMoversAndShakers(mockClient, mockSite, {
      query: gsc.where(between(date, '2026-01-01', '2026-01-07')),
      compareQuery: gsc.where(between(date, '2025-12-01', '2025-12-31')),
    })

    expect(result.periods.recent.start).toBe('2026-01-01')
    expect(result.periods.recent.end).toBe('2026-01-07')
    expect(result.periods.baseline.start).toBe('2025-12-01')
    expect(result.periods.baseline.end).toBe('2025-12-31')
  })
})

describe('analyzeContentDecay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should detect decaying pages', async () => {
    // Current period data
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['/decaying-page'], clicks: 50, position: 8 },
          { keys: ['/stable-page'], clicks: 100, position: 5 },
        ],
      })
      // Previous period data (1 year ago)
      .mockResolvedValueOnce({
        rows: [
          { keys: ['/decaying-page'], clicks: 100, position: 4 },
          { keys: ['/stable-page'], clicks: 100, position: 5 },
        ],
      })

    const results = await analyzeContentDecay(mockClient, mockSite, { minPreviousClicks: 50, threshold: 0.2 })

    expect(results).toHaveLength(1)
    expect(results[0].page).toBe('/decaying-page')
    expect(results[0].lostClicks).toBe(50)
    expect(results[0].declinePercent).toBe(0.5)
    expect(results[0].positionDrop).toBe(4) // 8 - 4
  })

  it('should filter by threshold', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['/slight-decay'], clicks: 90 }, // 10% drop
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['/slight-decay'], clicks: 100 },
        ],
      })

    const results = await analyzeContentDecay(mockClient, mockSite, { threshold: 0.2 }) // 20% threshold

    expect(results).toHaveLength(0)
  })

  it('should sort by different metrics', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['/page-a'], clicks: 50 }, // Lost 50 (50%)
          { keys: ['/page-b'], clicks: 800 }, // Lost 200 (20%)
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['/page-a'], clicks: 100 },
          { keys: ['/page-b'], clicks: 1000 },
        ],
      })

    // Sort by lostClicks (default)
    const byLost = await analyzeContentDecay(mockClient, mockSite, { sortBy: 'lostClicks' })
    expect(byLost[0].page).toBe('/page-b') // Lost 200

    // Reset mocks for next call
    vi.clearAllMocks()
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { keys: ['/page-a'], clicks: 50 }, // Lost 50 (50%)
          { keys: ['/page-b'], clicks: 800 }, // Lost 200 (20%)
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { keys: ['/page-a'], clicks: 100 },
          { keys: ['/page-b'], clicks: 1000 },
        ],
      })

    // Sort by declinePercent
    const byPercent = await analyzeContentDecay(mockClient, mockSite, { sortBy: 'declinePercent' })
    expect(byPercent[0].page).toBe('/page-a') // 50% decline
  })
})

describe('analyzeZeroClickQueries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should find zero-click queries', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['zero-click', '/page-1'], impressions: 2000, clicks: 10, ctr: 0.005, position: 1 },
        { keys: ['normal', '/page-2'], impressions: 2000, clicks: 500, ctr: 0.25, position: 1 },
      ],
    })

    const results = await analyzeZeroClickQueries(mockClient, mockSite)

    expect(results).toHaveLength(1)
    expect(results[0].query).toBe('zero-click')
    expect(results[0].ctr).toBe(0.005)
  })

  it('should filter by minImpressions and maxCtr', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { keys: ['low-imp', '/page-1'], impressions: 100, clicks: 0, ctr: 0, position: 1 },
        { keys: ['high-ctr', '/page-2'], impressions: 2000, clicks: 200, ctr: 0.1, position: 1 },
      ],
    })

    const results = await analyzeZeroClickQueries(mockClient, mockSite, { minImpressions: 1000, maxCtr: 0.03 })

    expect(results).toHaveLength(0)
  })
})
