import type { GscDb } from '@gscdump/db'
import type { OAuth2Client } from 'google-auth-library'
import {
  getSiteByProperty,
  hasDataForRange,
  queryCountriesWithComparison,
  queryDevicesWithComparison,
  queryKeywordsWithComparison,
  queryPages,
  queryPagesWithComparison,
} from '@gscdump/db'
import {
  fetchCountriesWithComparison,
  fetchDevicesWithComparison,
  fetchKeywordsWithComparison,
  fetchPages,
  fetchPagesWithComparison,
} from 'gscdump'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApiProvider,
  createDbProvider,
  createProvider,
} from '../src/provider'

// Mock gscdump
vi.mock('gscdump', () => ({
  fetchPages: vi.fn(),
  fetchPagesWithComparison: vi.fn(),
  fetchKeywordsWithComparison: vi.fn(),
  fetchCountriesWithComparison: vi.fn(),
  fetchDevicesWithComparison: vi.fn(),
}))

// Mock @gscdump/db
vi.mock('@gscdump/db', () => ({
  getSiteByProperty: vi.fn(),
  hasDataForRange: vi.fn(),
  queryPages: vi.fn(),
  queryPagesWithComparison: vi.fn(),
  queryKeywordsWithComparison: vi.fn(),
  queryCountriesWithComparison: vi.fn(),
  queryDevicesWithComparison: vi.fn(),
}))

// Mock data
const mockPageData = [
  { page: 'https://example.com/', clicks: 100, impressions: 1000, ctr: 0.1, position: 5.5 },
]

const mockPagesComparison = {
  current: [{ page: '/page1', clicks: 100, impressions: 1000, ctr: 0.1, position: 5, keys: null }],
  previous: [],
  metadata: { currentCount: 1, previousCount: 0 },
}

const mockKeywordsComparison = {
  current: [{ keyword: 'test', clicks: 50, impressions: 500, ctr: 0.1, position: 3, keys: null }],
  previous: [],
  metadata: { currentCount: 1, previousCount: 0 },
}

const mockCountriesComparison = {
  current: [{ country: 'USA', countryCode: 'US', countryCodeGsc: 'usa', clicks: 100, impressions: 1000, ctr: 0.1, position: 5, keys: null }],
  previous: [],
  metadata: { currentCount: 1, previousCount: 0 },
}

const mockDevicesComparison = {
  current: [{ device: 'MOBILE', clicks: 80, impressions: 800, ctr: 0.1, position: 4, keys: null }],
  previous: [],
  metadata: { currentCount: 1, previousCount: 0 },
}

const mockRange = {
  period: { start: '2024-01-10', end: '2024-01-12' },
  prevPeriod: { start: '2024-01-01', end: '2024-01-03' },
}

describe('createApiProvider', () => {
  const mockAuth = {} as OAuth2Client

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(fetchPages).mockResolvedValue(mockPageData as never)
    vi.mocked(fetchPagesWithComparison).mockResolvedValue(mockPagesComparison as never)
    vi.mocked(fetchKeywordsWithComparison).mockResolvedValue(mockKeywordsComparison as never)
    vi.mocked(fetchCountriesWithComparison).mockResolvedValue(mockCountriesComparison as never)
    vi.mocked(fetchDevicesWithComparison).mockResolvedValue(mockDevicesComparison as never)
  })

  it('has source set to api', () => {
    const provider = createApiProvider(mockAuth)
    expect(provider.source).toBe('api')
  })

  it('getPages calls fetchPages with correct args', async () => {
    const provider = createApiProvider(mockAuth)

    await provider.getPages('https://example.com/', mockRange)

    expect(fetchPages).toHaveBeenCalledWith(
      mockAuth,
      mockRange,
      expect.objectContaining({ siteUrl: 'https://example.com/' }),
    )
  })

  it('getPagesWithComparison calls fetchPagesWithComparison', async () => {
    const provider = createApiProvider(mockAuth)

    const result = await provider.getPagesWithComparison('https://example.com/', mockRange)

    expect(fetchPagesWithComparison).toHaveBeenCalled()
    expect(result.current).toHaveLength(1)
  })

  it('getKeywordsWithComparison calls fetchKeywordsWithComparison', async () => {
    const provider = createApiProvider(mockAuth)

    const result = await provider.getKeywordsWithComparison('https://example.com/', mockRange)

    expect(fetchKeywordsWithComparison).toHaveBeenCalled()
    expect(result.current[0].keyword).toBe('test')
  })

  it('getCountriesWithComparison calls fetchCountriesWithComparison', async () => {
    const provider = createApiProvider(mockAuth)

    const result = await provider.getCountriesWithComparison('https://example.com/', mockRange)

    expect(fetchCountriesWithComparison).toHaveBeenCalled()
    expect(result.current[0].country).toBe('USA')
  })

  it('getDevicesWithComparison calls fetchDevicesWithComparison', async () => {
    const provider = createApiProvider(mockAuth)

    const result = await provider.getDevicesWithComparison('https://example.com/', mockRange)

    expect(fetchDevicesWithComparison).toHaveBeenCalled()
    expect(result.current[0].device).toBe('MOBILE')
  })
})

describe('createDbProvider', () => {
  const mockDb = {} as GscDb
  const siteIdMap = new Map([['https://example.com/', 1]])

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(queryPages).mockResolvedValue(mockPageData as never)
    vi.mocked(queryPagesWithComparison).mockResolvedValue(mockPagesComparison as never)
    vi.mocked(queryKeywordsWithComparison).mockResolvedValue(mockKeywordsComparison as never)
    vi.mocked(queryCountriesWithComparison).mockResolvedValue(mockCountriesComparison as never)
    vi.mocked(queryDevicesWithComparison).mockResolvedValue(mockDevicesComparison as never)
  })

  it('has source set to db', () => {
    const provider = createDbProvider(mockDb, siteIdMap)
    expect(provider.source).toBe('db')
  })

  it('getPages calls queryPages with siteId', async () => {
    const provider = createDbProvider(mockDb, siteIdMap)

    await provider.getPages('https://example.com/', mockRange)

    expect(queryPages).toHaveBeenCalledWith(
      mockDb,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
    )
  })

  it('getPagesWithComparison passes current and previous date ranges', async () => {
    const provider = createDbProvider(mockDb, siteIdMap)

    await provider.getPagesWithComparison('https://example.com/', mockRange)

    expect(queryPagesWithComparison).toHaveBeenCalledWith(
      mockDb,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
      { startDate: '2024-01-01', endDate: '2024-01-03' },
    )
  })

  it('throws error for unknown site', async () => {
    const provider = createDbProvider(mockDb, siteIdMap)

    await expect(provider.getPages('https://unknown.com/', mockRange))
      .rejects
      .toThrow('Site not found in database: https://unknown.com/')
  })

  it('handles range without prevPeriod', async () => {
    const provider = createDbProvider(mockDb, siteIdMap)
    const rangeNoPrev = { period: { start: '2024-01-10', end: '2024-01-12' } }

    await provider.getPagesWithComparison('https://example.com/', rangeNoPrev)

    expect(queryPagesWithComparison).toHaveBeenCalledWith(
      mockDb,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
      undefined,
    )
  })

  it('getKeywordsWithComparison uses correct siteId', async () => {
    const provider = createDbProvider(mockDb, siteIdMap)

    await provider.getKeywordsWithComparison('https://example.com/', mockRange)

    expect(queryKeywordsWithComparison).toHaveBeenCalledWith(
      mockDb,
      1,
      expect.any(Object),
      expect.any(Object),
    )
  })

  it('getCountriesWithComparison uses correct siteId', async () => {
    const provider = createDbProvider(mockDb, siteIdMap)

    await provider.getCountriesWithComparison('https://example.com/', mockRange)

    expect(queryCountriesWithComparison).toHaveBeenCalledWith(
      mockDb,
      1,
      expect.any(Object),
      expect.any(Object),
    )
  })

  it('getDevicesWithComparison uses correct siteId', async () => {
    const provider = createDbProvider(mockDb, siteIdMap)

    await provider.getDevicesWithComparison('https://example.com/', mockRange)

    expect(queryDevicesWithComparison).toHaveBeenCalledWith(
      mockDb,
      1,
      expect.any(Object),
      expect.any(Object),
    )
  })
})

describe('createProvider', () => {
  const mockAuth = {} as OAuth2Client
  const mockDb = {} as GscDb

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(getSiteByProperty).mockResolvedValue({ siteId: 1, property: 'https://example.com/' } as never)
    vi.mocked(hasDataForRange).mockResolvedValue(true)
  })

  it('returns API provider when source is api', async () => {
    const provider = await createProvider({
      auth: mockAuth,
      db: mockDb,
      source: 'api',
      siteUrls: ['https://example.com/'],
      range: mockRange,
    })

    expect(provider.source).toBe('api')
  })

  it('returns API provider when db is null', async () => {
    const provider = await createProvider({
      auth: mockAuth,
      db: null,
      source: 'auto',
      siteUrls: ['https://example.com/'],
      range: mockRange,
    })

    expect(provider.source).toBe('api')
  })

  it('returns DB provider when source is db and sites exist', async () => {
    const provider = await createProvider({
      auth: mockAuth,
      db: mockDb,
      source: 'db',
      siteUrls: ['https://example.com/'],
      range: mockRange,
    })

    expect(provider.source).toBe('db')
  })

  it('throws error when source is db but site not in database', async () => {
    vi.mocked(getSiteByProperty).mockResolvedValue(null as never)

    await expect(createProvider({
      auth: mockAuth,
      db: mockDb,
      source: 'db',
      siteUrls: ['https://example.com/'],
      range: mockRange,
    })).rejects.toThrow('Sites not found in database')
  })

  it('auto mode returns DB provider when data exists', async () => {
    vi.mocked(hasDataForRange).mockResolvedValue(true)

    const provider = await createProvider({
      auth: mockAuth,
      db: mockDb,
      source: 'auto',
      siteUrls: ['https://example.com/'],
      range: mockRange,
    })

    expect(provider.source).toBe('db')
    expect(hasDataForRange).toHaveBeenCalled()
  })

  it('auto mode returns API provider when no data in DB', async () => {
    vi.mocked(hasDataForRange).mockResolvedValue(false)

    const provider = await createProvider({
      auth: mockAuth,
      db: mockDb,
      source: 'auto',
      siteUrls: ['https://example.com/'],
      range: mockRange,
    })

    expect(provider.source).toBe('api')
  })

  it('auto mode returns API provider when site not synced', async () => {
    vi.mocked(getSiteByProperty).mockResolvedValue(null as never)

    const provider = await createProvider({
      auth: mockAuth,
      db: mockDb,
      source: 'auto',
      siteUrls: ['https://example.com/'],
      range: mockRange,
    })

    expect(provider.source).toBe('api')
  })

  it('auto mode checks all sites for data', async () => {
    vi.mocked(getSiteByProperty)
      .mockResolvedValueOnce({ siteId: 1, property: 'https://site1.com/' } as never)
      .mockResolvedValueOnce({ siteId: 2, property: 'https://site2.com/' } as never)
    vi.mocked(hasDataForRange)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false) // Second site has no data

    const provider = await createProvider({
      auth: mockAuth,
      db: mockDb,
      source: 'auto',
      siteUrls: ['https://site1.com/', 'https://site2.com/'],
      range: mockRange,
    })

    // Should fall back to API since not all sites have data
    expect(provider.source).toBe('api')
  })

  it('auto mode uses DB when all sites have data', async () => {
    vi.mocked(getSiteByProperty)
      .mockResolvedValueOnce({ siteId: 1, property: 'https://site1.com/' } as never)
      .mockResolvedValueOnce({ siteId: 2, property: 'https://site2.com/' } as never)
    vi.mocked(hasDataForRange)
      .mockResolvedValue(true)

    const provider = await createProvider({
      auth: mockAuth,
      db: mockDb,
      source: 'auto',
      siteUrls: ['https://site1.com/', 'https://site2.com/'],
      range: mockRange,
    })

    expect(provider.source).toBe('db')
  })
})
