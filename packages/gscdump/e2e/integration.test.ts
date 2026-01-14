import type { OAuth2Client } from 'googleapis-common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchGscSites,
  fetchGscSitesWithSitemaps,
  inspectGscUrl,
} from '../src/api'
import {
  createQueryBody,
  fetchAnalyticsWithComparison,
  fetchCountriesWithComparison,
  fetchDevicesWithComparison,
  fetchKeywordsWithComparison,
  fetchPagesWithComparison,
} from '../src/searchanalytics'
import { userPeriodRange } from '../src/utils'
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

// Create mock API methods
const mockSitesList = vi.fn()
const mockSitemapsList = vi.fn()
const mockUrlInspect = vi.fn()
const mockSearchAnalyticsQuery = vi.fn()

// Mock the Google Search Console module
vi.mock('@googleapis/searchconsole', () => ({
  searchconsole: vi.fn(() => ({
    sites: {
      list: mockSitesList,
    },
    sitemaps: {
      list: mockSitemapsList,
    },
    urlInspection: {
      index: {
        inspect: mockUrlInspect,
      },
    },
    searchanalytics: {
      query: mockSearchAnalyticsQuery,
    },
  })),
}))

// Mock OAuth2Client with realistic properties
const mockAuth = {
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('full API Workflow', () => {
    it('should complete a full GSC data fetch workflow', async () => {
      // Setup all mocks for the workflow
      mockSitesList.mockResolvedValue({
        data: { siteEntry: mockSites },
      })

      mockSitemapsList.mockResolvedValue({
        data: { sitemap: mockSitemaps },
      })

      mockUrlInspect.mockResolvedValue({
        data: mockUrlInspection,
      })

      // Mock search analytics calls for different data types
      mockSearchAnalyticsQuery
        // Device data current period
        .mockResolvedValueOnce({ data: { rows: mockDeviceData } })
        // Device data previous period
        .mockResolvedValueOnce({ data: { rows: mockDeviceData } })
        // Country data current period
        .mockResolvedValueOnce({ data: { rows: mockCountryData } })
        // Country data previous period
        .mockResolvedValueOnce({ data: { rows: mockCountryData } })
        // Country keywords count queries
        .mockResolvedValue({ data: { rows: mockKeywordData } })

      // Step 1: Fetch sites
      const sites = await fetchGscSites(mockAuth)
      expect(sites).toMatchSnapshot()

      // Step 2: Fetch sites with sitemaps
      const sitesWithSitemaps = await fetchGscSitesWithSitemaps(mockAuth)
      expect(sitesWithSitemaps).toMatchSnapshot()

      // Step 3: Inspect a URL
      const inspection = await inspectGscUrl(
        mockAuth,
        'https://example.com/',
        'https://example.com/page',
      )
      expect(inspection).toMatchSnapshot()

      // Step 4: Fetch analytics data with date ranges
      const range = userPeriodRange('30d')

      const devices = await fetchDevicesWithComparison(mockAuth, mockSite, range)
      expect(devices).toMatchSnapshot()

      const countries = await fetchCountriesWithComparison(mockAuth, mockSite, range)
      expect(countries).toMatchSnapshot()

      // Verify all expected API calls were made
      expect(mockSitesList).toHaveBeenCalledTimes(2) // once for sites, once for sitesWithSitemaps
      expect(mockSitemapsList).toHaveBeenCalledTimes(2) // once for each owner site (2 owners)
      expect(mockUrlInspect).toHaveBeenCalledTimes(1)
      expect(mockSearchAnalyticsQuery).toHaveBeenCalled()
    })

    it('should handle comprehensive analytics data fetching', async () => {
      const range = userPeriodRange('7d')

      // Mock all the different analytics calls
      mockSearchAnalyticsQuery
        // Analytics summary current
        .mockResolvedValueOnce({ data: { rows: mockAnalyticsData } })
        // Analytics summary previous
        .mockResolvedValueOnce({ data: { rows: mockAnalyticsData } })
        // Keywords current
        .mockResolvedValueOnce({ data: { rows: mockKeywordData } })
        // Keywords previous
        .mockResolvedValueOnce({ data: { rows: mockKeywordData } })
        // Pages current
        .mockResolvedValueOnce({ data: { rows: mockPageData } })
        // Pages previous
        .mockResolvedValueOnce({ data: { rows: mockPageData } })
        // Page-keyword mapping
        .mockResolvedValueOnce({ data: { rows: mockKeywordData } })
        // Keywords current
        .mockResolvedValueOnce({ data: { rows: mockKeywordData } })
        // Keywords previous
        .mockResolvedValueOnce({ data: { rows: mockKeywordData } })
        // Keyword-page mapping
        .mockResolvedValueOnce({ data: { rows: mockPageData } })

      const analytics = await fetchAnalyticsWithComparison(mockAuth, mockSite, range)
      expect(analytics).toMatchSnapshot()

      const pages = await fetchPagesWithComparison(mockAuth, mockSite, range)
      expect(pages).toMatchSnapshot()

      const keywords = await fetchKeywordsWithComparison(mockAuth, mockSite, range)
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

    it('should handle different period ranges correctly', () => {
      const periods = [
        '7d',
        '30d',
        '90d',
        '2mo',
        '6mo',
      ]

      // Test the structure of period ranges without exact dates
      const results = periods.map((period) => {
        const range = userPeriodRange(period)
        return {
          period,
          structure: {
            hasPeriod: !!range.period,
            hasPrevPeriod: !!range.prevPeriod,
            hasStartEnd: !!(range.period.start && range.period.end),
            periodLength: Math.ceil((range.period.end.getTime() - range.period.start.getTime()) / (1000 * 60 * 60 * 24)),
            prevPeriodLength: Math.ceil((range.prevPeriod.end.getTime() - range.prevPeriod.start.getTime()) / (1000 * 60 * 60 * 24)),
          },
        }
      })

      expect(results).toMatchSnapshot()
    })

    it('should handle error scenarios gracefully', async () => {
      // Mock API errors
      mockSitesList.mockRejectedValue(new Error('API quota exceeded'))

      await expect(fetchGscSites(mockAuth)).rejects.toThrow('API quota exceeded')

      // Mock empty responses
      mockSitesList.mockResolvedValue({ data: {} })
      const emptySites = await fetchGscSites(mockAuth)
      expect(emptySites).toEqual([])
      expect(emptySites).toMatchSnapshot()

      // Mock null/undefined responses
      mockSearchAnalyticsQuery.mockResolvedValue({ data: { rows: null } })
      const devices = await fetchDevicesWithComparison(mockAuth, mockSite, userPeriodRange('7d'))
      expect(devices.current).toEqual([])
      expect(devices).toMatchSnapshot()
    })
  })

  describe('data Transformation Tests', () => {
    it('should properly transform device data', async () => {
      mockSearchAnalyticsQuery
        .mockResolvedValueOnce({ data: { rows: mockDeviceData } })
        .mockResolvedValueOnce({ data: { rows: mockDeviceData } })

      const result = await fetchDevicesWithComparison(
        mockAuth,
        mockSite,
        userPeriodRange('30d'),
      )

      // Check that keys are removed and device property is added
      expect(result.current[0]).toHaveProperty('device', 'desktop')
      expect(result.current[0]).toHaveProperty('keys', null)
      expect(result.current[0]).toHaveProperty('clicks', 1250.0)

      expect(result).toMatchSnapshot()
    })

    it('should properly transform country data with keywords', async () => {
      mockSearchAnalyticsQuery
        // Countries current
        .mockResolvedValueOnce({ data: { rows: mockCountryData } })
        // Countries previous
        .mockResolvedValueOnce({ data: { rows: mockCountryData } })
        // Keyword counts for each country
        .mockResolvedValue({ data: { rows: mockKeywordData } })

      const result = await fetchCountriesWithComparison(
        mockAuth,
        mockSite,
        userPeriodRange('30d'),
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
