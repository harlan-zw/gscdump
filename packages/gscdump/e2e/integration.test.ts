import type { OAuth2Client } from 'googleapis-common'
import type { ResolvedAnalyticsRange } from '../src'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createQueryBody,
  fetchAnalyticsWithComparison,
  fetchCountriesWithComparison,
  fetchDevicesWithComparison,
  fetchKeywordsWithComparison,
  fetchPagesWithComparison,
  fetchSites,
  fetchSitesWithSitemaps,
  inspectUrl,
} from '../src'
import { createMockGoogleSearchConsoleClient } from './__fixtures__/mock-client-logic'
import {
  mockAnalyticsData,
  mockCountryData,
  mockDeviceData,
  mockKeywordData,
  mockPageData,
  mockSitemaps,
  mockSites,
  mockUrlInspection,
} from './__fixtures__/mock-responses'

function createTestRange(days: number): ResolvedAnalyticsRange {
  const end = new Date()
  const start = new Date(end.getTime() - days * 86400000)
  const prevEnd = new Date(start.getTime() - 86400000)
  const prevStart = new Date(prevEnd.getTime() - days * 86400000)
  const fmt = (d: Date) => d.toISOString().split('T')[0]
  return {
    period: { start: fmt(start), end: fmt(end) },
    prevPeriod: { start: fmt(prevStart), end: fmt(prevEnd) },
  }
}

const _mockAuth = {
  credentials: {
    access_token: 'mock_access_token',
    token_type: 'Bearer',
  },
  generateAccessToken: vi.fn().mockResolvedValue({
    token: 'mock_access_token',
  }),
} as unknown as OAuth2Client

const mockSite = {
  siteUrl: 'https://example.com/',
  permissionLevel: 'owner',
}

describe('e2E Integration Tests', () => {
  let mockClient: ReturnType<typeof createMockGoogleSearchConsoleClient>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-14'))
    vi.resetAllMocks()
    mockClient = createMockGoogleSearchConsoleClient()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('full API Workflow', () => {
    it('should complete a full GSC data fetch workflow', async () => {
      // Setup all mocks for the workflow
      vi.mocked(mockClient.sites.list).mockResolvedValue({ siteEntry: mockSites })

      vi.mocked(mockClient.sitemaps.list).mockResolvedValue({ sitemap: mockSitemaps })

      vi.mocked(mockClient.urlInspection.inspect).mockResolvedValue(mockUrlInspection)

      // Mock search analytics calls for different data types
      vi.mocked(mockClient.searchAnalytics.query)
        // Device data current period
        .mockResolvedValueOnce({ rows: mockDeviceData })
        // Device data previous period
        .mockResolvedValueOnce({ rows: mockDeviceData })
        // Country data current period
        .mockResolvedValueOnce({ rows: mockCountryData })
        // Country data previous period
        .mockResolvedValueOnce({ rows: mockCountryData })
        // Country keywords count queries
        .mockResolvedValue({ rows: mockKeywordData })

      // Step 1: Fetch sites
      const sites = await fetchSites(mockClient)
      expect(sites).toMatchSnapshot()

      // Step 2: Fetch sites with sitemaps
      const sitesWithSitemaps = await fetchSitesWithSitemaps(mockClient)
      expect(sitesWithSitemaps).toMatchSnapshot()

      // Step 3: Inspect a URL
      const inspection = await inspectUrl(
        mockClient,
        'https://example.com/',
        'https://example.com/page',
      )
      expect(inspection).toMatchSnapshot()

      // Step 4: Fetch analytics data with date ranges
      const range = createTestRange(30)

      const devices = await fetchDevicesWithComparison(mockClient, mockSite.siteUrl, range)
      expect(devices).toMatchSnapshot()

      const countries = await fetchCountriesWithComparison(mockClient, mockSite.siteUrl, range)
      expect(countries).toMatchSnapshot()

      // Verify all expected API calls were made
      expect(mockClient.sites.list).toHaveBeenCalledTimes(2) // once for sites, once for sitesWithSitemaps
      expect(mockClient.sitemaps.list).toHaveBeenCalledTimes(2) // once for each owner site (2 owners)
      expect(mockClient.urlInspection.inspect).toHaveBeenCalledTimes(1)
      expect(mockClient.searchAnalytics.query).toHaveBeenCalled()
    })

    it('should handle comprehensive analytics data fetching', async () => {
      const range = createTestRange(7)

      // Mock all the different analytics calls
      vi.mocked(mockClient.searchAnalytics.query)
        // Analytics summary current
        .mockResolvedValueOnce({ rows: mockAnalyticsData } as any)
        // Analytics summary previous
        .mockResolvedValueOnce({ rows: mockAnalyticsData } as any)
        // Keywords current
        .mockResolvedValueOnce({ rows: mockKeywordData } as any)
        // Keywords previous
        .mockResolvedValueOnce({ rows: mockKeywordData } as any)
        // Pages current
        .mockResolvedValueOnce({ rows: mockPageData } as any)
        // Pages previous
        .mockResolvedValueOnce({ rows: mockPageData } as any)
        // Page-keyword mapping
        .mockResolvedValueOnce({ rows: mockKeywordData } as any)
        // Keywords current
        .mockResolvedValueOnce({ rows: mockKeywordData } as any)
        // Keywords previous
        .mockResolvedValueOnce({ rows: mockKeywordData } as any)
        // Keyword-page mapping
        .mockResolvedValueOnce({ rows: mockPageData } as any)

      const analytics = await fetchAnalyticsWithComparison(mockClient, mockSite.siteUrl, range)
      expect(analytics).toMatchSnapshot()

      const pages = await fetchPagesWithComparison(mockClient, mockSite.siteUrl, range)
      expect(pages).toMatchSnapshot()

      const keywords = await fetchKeywordsWithComparison(mockClient, mockSite.siteUrl, range)
      expect(keywords).toMatchSnapshot()
    })

    it('should generate proper query bodies with different options', () => {
      // Test default query body
      const defaultQuery = createQueryBody()
      expect(defaultQuery).toMatchSnapshot()

      // Test with custom period
      const customPeriod = createQueryBody({
        period: {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-31'),
        },
      })
      expect(customPeriod).toMatchSnapshot()

      // Test with domain filter
      const domainQuery = createQueryBody({
        domain: 'https://example.com',
        filters: [
          {
            dimension: 'query',
            operator: 'contains',
            expression: 'test',
          },
        ],
      })
      expect(domainQuery).toMatchSnapshot()

      // Test with multiple filters
      const complexQuery = createQueryBody({
        period: {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-31'),
        },
        domain: 'https://example.com',
        filters: [
          {
            dimension: 'query',
            operator: 'contains',
            expression: 'guide',
          },
          {
            dimension: 'page',
            operator: 'notContains',
            expression: '/admin',
          },
        ],
      })
      expect(complexQuery).toMatchSnapshot()
    })

    it('should handle error scenarios gracefully', async () => {
      // Mock API errors
      vi.mocked(mockClient.sites.list).mockRejectedValue(new Error('API quota exceeded'))

      await expect(fetchSites(mockClient)).rejects.toThrow('API quota exceeded')

      // Mock empty responses
      vi.mocked(mockClient.sites.list).mockResolvedValue({})
      const emptySites = await fetchSites(mockClient)
      expect(emptySites).toEqual([])
      expect(emptySites).toMatchSnapshot()

      // Mock null/undefined responses
      vi.mocked(mockClient.searchAnalytics.query).mockResolvedValue({ rows: null } as any)
      const devices = await fetchDevicesWithComparison(mockClient, mockSite.siteUrl, createTestRange(7))
      expect(devices.current).toEqual([])
      expect(devices).toMatchSnapshot()
    })
  })

  describe('data Transformation Tests', () => {
    it('should properly transform device data', async () => {
      vi.mocked(mockClient.searchAnalytics.query)
        .mockResolvedValueOnce({ rows: mockDeviceData } as any)
        .mockResolvedValueOnce({ rows: mockDeviceData } as any)

      const result = await fetchDevicesWithComparison(
        mockClient,
        mockSite.siteUrl,
        createTestRange(30),
      )

      // Check that keys are removed and device property is added
      expect(result.current[0]).toHaveProperty('device', 'desktop')
      expect(result.current[0]).toHaveProperty('keys', null)
      expect(result.current[0]).toHaveProperty('clicks', 1250.0)

      expect(result).toMatchSnapshot()
    })

    it('should properly transform country data with keywords', async () => {
      vi.mocked(mockClient.searchAnalytics.query)
        // Countries current
        .mockResolvedValueOnce({ rows: mockCountryData } as any)
        // Countries previous
        .mockResolvedValueOnce({ rows: mockCountryData } as any)
        // Keyword counts for each country
        .mockResolvedValue({ rows: mockKeywordData } as any)

      const result = await fetchCountriesWithComparison(
        mockClient,
        mockSite.siteUrl,
        createTestRange(30),
      )

      // Check transformation includes country names and keyword counts
      expect(result.current[0]).toHaveProperty('countryCodeGsc', 'usa')
      expect(result.current[0]).toHaveProperty('country')
      expect(result.current[0]).toHaveProperty('countryCode')
      expect(result.current[0]).toHaveProperty('keywords')

      expect(result).toMatchSnapshot()
    })
  })
})
