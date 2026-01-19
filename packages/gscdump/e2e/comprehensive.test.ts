import type { OAuth2Client } from 'googleapis-common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createQueryBody,
  fetchAnalyticsWithComparison,
  fetchCountriesWithComparison,
  fetchDevicesWithComparison,
  fetchKeywordsWithComparison,
  fetchSites,
  fetchSitesWithSitemaps,
  inspectUrl,
  percentDifference,
  queryRecursive,
  userPeriodRange,
} from '../src'
import { createMockGoogleSearchConsoleClient } from './__fixtures__/mock-client-logic'
import {
  mockDeviceData,
  mockSitemaps,
  mockSites,
  mockUrlInspection,
} from './__fixtures__/mock-responses'

const _mockAuth = {
  credentials: { access_token: 'test_token' },
  generateAccessToken: vi.fn().mockResolvedValue({ token: 'test_token' }),
} as unknown as OAuth2Client

describe('comprehensive E2E Tests', () => {
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

  describe('edge Cases and Error Scenarios', () => {
    it('should handle various API error responses gracefully', async () => {
      const errorScenarios = [
        { error: new Error('API quota exceeded'), expectedMessage: 'API quota exceeded' },
        { error: new Error('Invalid authentication credentials'), expectedMessage: 'Invalid authentication credentials' },
        { error: new Error('Forbidden'), expectedMessage: 'Forbidden' },
        { error: new Error('Rate limit exceeded'), expectedMessage: 'Rate limit exceeded' },
        { error: { response: { status: 429, statusText: 'Too Many Requests' } }, expectedMessage: undefined },
      ]

      for (const scenario of errorScenarios) {
        vi.mocked(mockClient.sites.list).mockRejectedValueOnce(scenario.error)

        if (scenario.expectedMessage) {
          await expect(fetchSites(mockClient)).rejects.toThrow(scenario.expectedMessage)
        }
        else {
          await expect(fetchSites(mockClient)).rejects.toThrow()
        }
      }

      expect(mockClient.sites.list).toHaveBeenCalledTimes(errorScenarios.length)
    })

    it('should handle malformed API responses', async () => {
      const malformedResponses = [
        null,
        undefined,
        {},
        { data: null },
        { data: { siteEntry: null } },
        { data: { siteEntry: [] } },
        { data: { siteEntry: [null, undefined, {}] } },
        { data: { siteEntry: [{ siteUrl: null }, { permissionLevel: null }] } },
      ]

      for (const response of malformedResponses) {
        vi.mocked(mockClient.sites.list).mockResolvedValueOnce(response as any)
        const result = await fetchSites(mockClient)
        expect(Array.isArray(result)).toBe(true)
        expect(result).toMatchSnapshot()
      }
    })

    it('should handle empty search analytics responses across all functions', async () => {
      const emptyResponse = { data: { rows: [] } }

      // Test all analytics functions with empty responses
      vi.mocked(mockClient.searchAnalytics.query).mockResolvedValue(emptyResponse as any)

      const site = { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' as const }
      const range = userPeriodRange('7d')

      const devices = await fetchDevicesWithComparison(mockClient, site.siteUrl, range)
      expect(devices.current).toEqual([])
      expect(devices.previous).toEqual([])
      expect(devices.metadata.currentCount).toBe(0)

      const countries = await fetchCountriesWithComparison(mockClient, site.siteUrl, range)
      expect(countries.current).toEqual([])

      const analytics = await fetchAnalyticsWithComparison(mockClient, site.siteUrl, range)
      expect(analytics.current[0].keywords).toEqual([])

      expect({ devices, countries, analytics }).toMatchSnapshot()
    })

    it('should handle different site URL formats correctly', async () => {
      const siteUrlFormats = [
        'https://example.com/',
        'http://example.com/',
        'https://www.example.com/',
        'https://subdomain.example.com/',
        'sc-domain:example.com',
        'sc-domain:www.example.com',
        'https://example.com:8080/',
        'https://example.com/path/',
        'https://example.com/path/?query=1',
      ]

      for (const siteUrl of siteUrlFormats) {
        const queryBody = createQueryBody({
          domain: siteUrl,
          period: { start: new Date('2024-01-01'), end: new Date('2024-01-31') },
        })

        expect(queryBody.dimensionFilterGroups).toBeDefined()
        expect(queryBody).toMatchSnapshot()
      }
    })

    it('should handle large datasets with pagination correctly', async () => {
      // Create large mock dataset (simulate 50,000 rows)
      const largeDataset = Array.from({ length: 50000 }, (_, i) => ({
        keys: [`page-${i}`],
        clicks: Math.floor(Math.random() * 1000),
        impressions: Math.floor(Math.random() * 10000),
        ctr: Math.random() * 0.1,
        position: Math.random() * 100,
      }))

      // Mock recursive pagination - first call gets 25k (triggering recursion), second gets remaining rows (stopping recursion)
      vi.mocked(mockClient.searchAnalytics.query)
        .mockResolvedValueOnce({ rows: largeDataset.slice(0, 25000) } as any)
        .mockResolvedValueOnce({ rows: largeDataset.slice(25000, 49000) } as any) // Less than 25k to stop recursion

      const api = mockClient

      const result = await queryRecursive(api, 'https://example.com/', {
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        dimensions: ['page'],
        rowLimit: 25000,
      })

      expect(result.rows).toHaveLength(49000) // Should have combined all rows (25k + 24k)
      expect(result.pages).toBeGreaterThan(1) // Should indicate multiple pages
      // Don't snapshot 49k rows - just verify structure
      expect(result.rows[0]).toHaveProperty('keys')
      expect(result.rows[0]).toHaveProperty('clicks')
    })
  })

  describe('complex Data Flow Scenarios', () => {
    it('should handle multi-site analytics comparison correctly', async () => {
      const multipleSites = [
        { siteUrl: 'https://site1.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://site2.com/', permissionLevel: 'siteFullUser' },
        { siteUrl: 'sc-domain:site3.com', permissionLevel: 'siteOwner' },
      ]

      mockClient.sites.list.mockResolvedValue({ siteEntry: multipleSites })

      // Mock different analytics data for each site
      const site1Data = [{ keys: ['desktop'], clicks: 1000, impressions: 10000, ctr: 0.1, position: 5 }]
      const site2Data = [{ keys: ['mobile'], clicks: 500, impressions: 8000, ctr: 0.0625, position: 8 }]
      const site3Data = [{ keys: ['tablet'], clicks: 100, impressions: 2000, ctr: 0.05, position: 12 }]

      vi.mocked(mockClient.searchAnalytics.query)
        .mockResolvedValueOnce({ rows: site1Data })
        .mockResolvedValueOnce({ rows: site1Data })
        .mockResolvedValueOnce({ rows: site2Data })
        .mockResolvedValueOnce({ rows: site2Data })
        .mockResolvedValueOnce({ rows: site3Data })
        .mockResolvedValueOnce({ rows: site3Data })

      const sites = await fetchSites(mockClient)
      expect(sites).toHaveLength(3)

      const range = userPeriodRange('30d')
      const analyticsPromises = sites.map(site =>
        fetchDevicesWithComparison(mockClient, site.siteUrl, range),
      )

      const results = await Promise.all(analyticsPromises)

      expect(results).toHaveLength(3)
      expect(results[0].current[0].device).toBe('desktop')
      expect(results[1].current[0].device).toBe('mobile')
      expect(results[2].current[0].device).toBe('tablet')

      expect(results).toMatchSnapshot()
    })

    it('should handle concurrent API calls without conflicts', async () => {
      // Test concurrent requests to different endpoints
      vi.mocked(mockClient.sites.list).mockResolvedValue({ data: { siteEntry: mockSites } } as any)
      vi.mocked(mockClient.searchAnalytics.query).mockResolvedValue({ data: { rows: mockDeviceData } } as any)
      vi.mocked(mockClient.urlInspection.inspect).mockResolvedValue(mockUrlInspection as any)
      vi.mocked(mockClient.sitemaps.list).mockResolvedValue({ sitemap: mockSitemaps } as any)

      const site = { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' as const }
      const range = userPeriodRange('7d')
      const urls = ['https://example.com/page1', 'https://example.com/page2', 'https://example.com/page3']

      // Run multiple operations concurrently
      const concurrentOperations = await Promise.all([
        fetchSites(mockClient),
        fetchSitesWithSitemaps(mockClient),
        fetchDevicesWithComparison(mockClient, site.siteUrl, range),
        fetchCountriesWithComparison(mockClient, site.siteUrl, range),
        ...urls.map(url => inspectUrl(mockClient, site.siteUrl, url)),
      ])

      expect(concurrentOperations).toHaveLength(7) // 1 + 1 + 1 + 1 + 3 inspections
      expect(mockClient.sites.list).toHaveBeenCalledTimes(2)
      expect(mockClient.searchAnalytics.query).toHaveBeenCalled()
      expect(mockClient.urlInspection.inspect).toHaveBeenCalledTimes(3)

      expect(concurrentOperations).toMatchSnapshot()
    })

    it('should handle period range edge cases and boundary conditions', async () => {
      const edgeCases = [
        '1d',
        '365d',
        '1mo',
        '12mo',
        'all',
        { start: new Date('2024-01-01'), end: new Date('2024-01-01') }, // Same day
        { start: new Date('2024-12-31'), end: new Date('2025-01-01') }, // Year boundary
        { start: new Date('2024-02-28'), end: new Date('2024-03-01') }, // Month boundary
        { start: new Date('2020-01-01'), end: new Date('2024-12-31') }, // Multi-year range
      ]

      const results = edgeCases.map((period) => {
        try {
          const range = userPeriodRange(period)
          return {
            input: period,
            success: true,
            periodDays: Math.ceil((range.period.end.getTime() - range.period.start.getTime()) / (1000 * 60 * 60 * 24)),
            prevPeriodDays: Math.ceil((range.prevPeriod.end.getTime() - range.prevPeriod.start.getTime()) / (1000 * 60 * 60 * 24)),
            hasValidDates: range.period.start < range.period.end,
            prevPeriodEndsBeforeCurrent: range.prevPeriod.end <= range.period.start,
          }
        }
        catch (error) {
          return {
            input: period,
            success: false,
            error: error.message,
          }
        }
      })

      expect(results).toMatchSnapshot()
    })
  })

  describe('data Integrity and Transformation Tests', () => {
    it('should maintain data consistency across different API responses', async () => {
      // Test that data transformations are consistent
      const baseData = {
        keys: ['test-key'],
        clicks: 100,
        impressions: 1000,
        ctr: 0.1,
        position: 5.5,
      }

      const variations = [
        { ...baseData, clicks: 0, impressions: 1000, ctr: 0 },
        { ...baseData, clicks: 1000, impressions: 0, ctr: 0 }, // Impossible but test handling
        { ...baseData, position: 0 },
        { ...baseData, position: 100 },
        { ...baseData, clicks: null, impressions: null },
        { ...baseData, keys: null },
        { ...baseData, keys: [] },
        { ...baseData, keys: ['', null, undefined] },
      ]

      vi.mocked(mockClient.searchAnalytics.query)
        .mockResolvedValueOnce({ rows: variations })
        .mockResolvedValueOnce({ rows: variations })

      const site = { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' as const }
      const range = userPeriodRange('7d')

      const result = await fetchDevicesWithComparison(mockClient, site.siteUrl, range)

      // Verify all rows are transformed consistently
      expect(result.current).toHaveLength(variations.length)
      result.current.forEach((row) => {
        expect(row).toHaveProperty('device')
        expect(row).toHaveProperty('keys', null)
        expect(typeof row.clicks).toBe('number')
        expect(typeof row.impressions).toBe('number')
      })

      expect(result).toMatchSnapshot()
    })

    it('should handle percentage calculations with edge values', async () => {
      const testCases = [
        [0, 0],
        [100, 0],
        [0, 100],
        [100, 100],
        [50, 100],
        [200, 100],
        [0.1, 0.2],
        [1000000, 999999],
        [-100, 100], // Negative values
        [100, -100],
        [Infinity, 100],
        [100, Infinity],
        [Number.NaN, 100],
        [100, Number.NaN],
      ]

      const results = testCases.map(([a, b]) => ({
        input: [a, b],
        result: percentDifference(a, b),
        isFinite: Number.isFinite(percentDifference(a, b)),
        isNaN: Number.isNaN(percentDifference(a, b)),
      }))

      expect(results).toMatchSnapshot()
    })

    it('should validate query body generation with complex filters', async () => {
      const complexScenarios = [
        {
          name: 'Multiple dimension filters',
          options: {
            period: { start: new Date('2024-01-01'), end: new Date('2024-01-31') },
            domain: 'https://example.com',
            filters: [
              { dimension: 'query', operator: 'contains', expression: 'test' },
              { dimension: 'page', operator: 'notContains', expression: '/admin' },
              { dimension: 'country', operator: 'equals', expression: 'USA' },
              { dimension: 'device', operator: 'notEquals', expression: 'TABLET' },
            ],
          },
        },
        {
          name: 'Regex filters',
          options: {
            period: { start: new Date('2024-01-01'), end: new Date('2024-01-31') },
            filters: [
              { dimension: 'page', operator: 'includingRegex', expression: '^https://example\\.com/(blog|news)/' },
              { dimension: 'query', operator: 'excludingRegex', expression: '(spam|test|debug)' },
            ],
          },
        },
        {
          name: 'Empty and null filters',
          options: {
            period: { start: new Date('2024-01-01'), end: new Date('2024-01-31') },
            filters: [
              { dimension: 'query', operator: 'contains', expression: '' },
              { dimension: 'page', operator: 'contains', expression: null },
              { dimension: null, operator: 'contains', expression: 'test' },
            ],
          },
        },
      ]

      const results = complexScenarios.map(scenario => ({
        name: scenario.name,
        queryBody: createQueryBody(scenario.options),
        filterCount: createQueryBody(scenario.options).dimensionFilterGroups?.[0]?.filters?.length || 0,
      }))

      expect(results).toMatchSnapshot()
    })
  })

  describe('performance and Load Scenarios', () => {
    it('should handle rapid sequential API calls efficiently', async () => {
      const callCount = 50
      const startTime = Date.now()

      // Mock fast responses
      vi.mocked(mockClient.sites.list).mockResolvedValue({ data: { siteEntry: mockSites } } as any)

      // Make rapid sequential calls
      const promises = Array.from({ length: callCount }, () => fetchSites(mockClient))
      const results = await Promise.all(promises)

      const endTime = Date.now()
      const totalTime = endTime - startTime

      expect(results).toHaveLength(callCount)
      expect(mockClient.sites.list).toHaveBeenCalledTimes(callCount)

      // Performance assertion (should complete reasonably fast)
      expect(totalTime).toBeLessThan(5000) // 5 seconds max

      // Don't snapshot timing values as they are inherently unstable
      expect(callCount).toBe(50)
      expect(results.every(r => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true)
    })

    it('should handle memory efficiently with large datasets', async () => {
      // Simulate processing large amounts of data
      const largeKeywordData = Array.from({ length: 10000 }, (_, i) => ({
        keys: [`keyword-${i}-${Math.random().toString(36).substring(7)}`],
        clicks: Math.floor(Math.random() * 1000),
        impressions: Math.floor(Math.random() * 10000),
        ctr: Math.random() * 0.2,
        position: Math.random() * 100,
      }))

      vi.mocked(mockClient.searchAnalytics.query)
        .mockResolvedValueOnce({ rows: largeKeywordData })
        .mockResolvedValueOnce({ rows: largeKeywordData.slice(0, 5000) })

      const site = { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' as const }
      const range = userPeriodRange('30d')

      const startMemory = process.memoryUsage()
      const result = await fetchKeywordsWithComparison(mockClient, site.siteUrl, range)
      const endMemory = process.memoryUsage()

      expect(result.current).toHaveLength(10000)
      expect(result.previous).toHaveLength(5000)

      const memoryDiff = {
        heapUsed: endMemory.heapUsed - startMemory.heapUsed,
        heapTotal: endMemory.heapTotal - startMemory.heapTotal,
        external: endMemory.external - startMemory.external,
      }

      // Don't snapshot exact memory values as they are inherently unstable
      expect(result.current.length).toBe(10000)
      expect(result.current.every(item => item.keyword && typeof item.clicks === 'number')).toBe(true)
      // Memory should not grow excessively (less than 50MB for 10k records)
      expect(memoryDiff.heapUsed).toBeLessThan(50 * 1024 * 1024)
    })
  })

  describe('site Permission and Access Control Tests', () => {
    it('should handle different permission levels correctly', async () => {
      const sitesWithDifferentPermissions = [
        { siteUrl: 'https://owner-site.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://full-site.com/', permissionLevel: 'siteFullUser' },
        { siteUrl: 'https://restricted-site.com/', permissionLevel: 'siteRestrictedUser' },
        { siteUrl: 'https://unverified-site.com/', permissionLevel: 'siteUnverifiedUser' },
        { siteUrl: 'https://readonly-site.com/', permissionLevel: 'siteOwner' }, // Legacy permission
      ]

      vi.mocked(mockClient.sites.list).mockResolvedValue({
        siteEntry: sitesWithDifferentPermissions,
      })

      // Mock sitemap responses based on permission (only called for siteOwner)
      vi.mocked(mockClient.sitemaps.list)
        .mockResolvedValueOnce({ sitemap: mockSitemaps }) // siteOwner 1
        .mockResolvedValueOnce({ sitemap: mockSitemaps }) // siteOwner 2 (legacy)

      const result = await fetchSitesWithSitemaps(mockClient)

      // Should filter out unverified users
      expect(result.some(site => site.permissionLevel === 'siteUnverifiedUser')).toBe(false)

      // Should handle sitemaps based on permission
      const ownerSites = result.filter(site => site.permissionLevel === 'siteOwner')
      const nonOwnerSites = result.filter(site => site.permissionLevel !== 'siteOwner')

      expect(ownerSites.every(site => site.sitemaps.length > 0)).toBe(true)
      expect(nonOwnerSites.every(site => site.sitemaps.length === 0)).toBe(true)

      expect(result).toMatchSnapshot()
    })
  })
})
