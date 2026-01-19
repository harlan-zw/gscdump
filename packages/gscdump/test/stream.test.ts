import type { GoogleSearchConsoleClient } from '../src'
import { collectStream, queryRecursiveStream } from '../src'

// Mock GoogleSearchConsoleClient
const mockClient = {
  sites: { list: vi.fn() },
  sitemaps: { list: vi.fn() },
  urlInspection: { inspect: vi.fn() },
  searchAnalytics: { query: vi.fn() },
  indexing: { publish: vi.fn(), getMetadata: vi.fn() },
} as unknown as GoogleSearchConsoleClient

describe('queryRecursiveStream', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should yield typed batches as they paginate', async () => {
    const batch1 = Array.from({ length: 25000 }, (_, i) => ({
      keys: [`keyword-${i}`, `/page-${i}`],
      clicks: i,
      impressions: i * 10,
      ctr: 0.1,
      position: 5,
    }))
    const batch2 = Array.from({ length: 100 }, (_, i) => ({
      keys: [`keyword-${25000 + i}`, `/page-${25000 + i}`],
      clicks: i,
      impressions: i * 10,
      ctr: 0.1,
      position: 5,
    }))

    vi.mocked(mockClient.searchAnalytics.query)
      .mockResolvedValueOnce({ rows: batch1 })
      .mockResolvedValueOnce({ rows: batch2 })

    const batches: Array<{ keyword: string, page: string }[]> = []
    for await (const batch of queryRecursiveStream(mockClient, 'https://example.com/', {
      dimensions: ['query', 'page'] as const,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })) {
      batches.push(batch)
      // Type check: these should compile
      expect(batch[0].keyword).toBeDefined()
      expect(batch[0].page).toBeDefined()
    }

    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(25000)
    expect(batches[1]).toHaveLength(100)
  })

  it('should map dimensions to correct field names', async () => {
    vi.mocked(mockClient.searchAnalytics.query)
      .mockResolvedValueOnce({
        rows: [{ keys: ['test-keyword', '/test-page'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 }],
      })

    const rows = await collectStream(queryRecursiveStream(mockClient, 'https://example.com/', {
      dimensions: ['query', 'page'] as const,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    }))

    expect(rows[0]).toEqual({
      keyword: 'test-keyword',
      page: '/test-page',
      clicks: 10,
      impressions: 100,
      ctr: 0.1,
      position: 5,
    })
  })

  it('should handle single dimension', async () => {
    vi.mocked(mockClient.searchAnalytics.query)
      .mockResolvedValueOnce({
        rows: [{ keys: ['/page-1'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 }],
      })

    const rows = await collectStream(queryRecursiveStream(mockClient, 'https://example.com/', {
      dimensions: ['page'] as const,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    }))

    expect(rows[0]).toEqual({
      page: '/page-1',
      clicks: 10,
      impressions: 100,
      ctr: 0.1,
      position: 5,
    })
  })

  it('should handle multiple dimensions', async () => {
    vi.mocked(mockClient.searchAnalytics.query)
      .mockResolvedValueOnce({
        rows: [{ keys: ['keyword', '/page', '2024-01-01', 'DESKTOP', 'usa'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 }],
      })

    const rows = await collectStream(queryRecursiveStream(mockClient, 'https://example.com/', {
      dimensions: ['query', 'page', 'date', 'device', 'country'] as const,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    }))

    expect(rows[0]).toEqual({
      keyword: 'keyword',
      page: '/page',
      date: '2024-01-01',
      device: 'DESKTOP',
      country: 'usa',
      clicks: 10,
      impressions: 100,
      ctr: 0.1,
      position: 5,
    })
  })

  it('should stop on empty response', async () => {
    vi.mocked(mockClient.searchAnalytics.query)
      .mockResolvedValueOnce({ rows: [] })

    const batches = []
    for await (const batch of queryRecursiveStream(mockClient, 'https://example.com/', {
      dimensions: ['query'] as const,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })) {
      batches.push(batch)
    }

    expect(batches).toHaveLength(0)
    expect(mockClient.searchAnalytics.query).toHaveBeenCalledTimes(1)
  })

  it('should stop when batch is smaller than rowLimit', async () => {
    vi.mocked(mockClient.searchAnalytics.query)
      .mockResolvedValueOnce({ rows: Array.from({ length: 100 }).fill({ keys: ['k'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }) })

    const batches = []
    for await (const batch of queryRecursiveStream(mockClient, 'https://example.com/', {
      dimensions: ['query'] as const,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })) {
      batches.push(batch)
    }

    expect(batches).toHaveLength(1)
    expect(mockClient.searchAnalytics.query).toHaveBeenCalledTimes(1)
  })

  it('should pass startRow correctly for pagination', async () => {
    vi.mocked(mockClient.searchAnalytics.query)
      .mockResolvedValueOnce({ rows: Array.from({ length: 25000 }).fill({ keys: ['k'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }) })
      .mockResolvedValueOnce({ rows: Array.from({ length: 100 }).fill({ keys: ['k'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }) })

    for await (const _ of queryRecursiveStream(mockClient, 'https://example.com/', {
      dimensions: ['query'] as const,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })) { /* consume */ }

    expect(mockClient.searchAnalytics.query).toHaveBeenNthCalledWith(1, 'https://example.com/', expect.objectContaining({
      startRow: 0,
      rowLimit: 25000,
    }))
    expect(mockClient.searchAnalytics.query).toHaveBeenNthCalledWith(2, 'https://example.com/', expect.objectContaining({
      startRow: 25000,
      rowLimit: 25000,
    }))
  })

  it('should respect custom rowLimit', async () => {
    vi.mocked(mockClient.searchAnalytics.query)
      .mockResolvedValueOnce({ rows: Array.from({ length: 1000 }).fill({ keys: ['k'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }) })
      .mockResolvedValueOnce({ rows: Array.from({ length: 100 }).fill({ keys: ['k'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }) })

    for await (const _ of queryRecursiveStream(mockClient, 'https://example.com/', {
      dimensions: ['query'] as const,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      rowLimit: 1000,
    })) { /* consume */ }

    expect(mockClient.searchAnalytics.query).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({
      rowLimit: 1000,
    }))
  })
})

describe('collectStream', () => {
  it('should collect all batches into single array', async () => {
    async function* gen() {
      yield [1, 2, 3]
      yield [4, 5]
      yield [6]
    }

    const result = await collectStream(gen())
    expect(result).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('should return empty array for empty generator', async () => {
    async function* gen(): AsyncGenerator<number[], void, undefined> {
      // empty
    }

    const result = await collectStream(gen())
    expect(result).toEqual([])
  })
})
