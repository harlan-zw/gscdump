import type { searchconsole_v1 } from '@googleapis/searchconsole/v1'
import type { OAuth2Client } from 'googleapis-common'
import type { AggregationType, DeviceData, KeywordData, PageData, QueryResultRow, Site } from '../src/searchanalytics'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { fetchGscSites, fetchGscSitesWithSitemaps, inspectGscUrl } from '../src/api'
import { createQueryBody, fetchDevicesWithComparison, withPropertyAggregation } from '../src/searchanalytics'
import { formatDateGsc, percentDifference, userPeriodRange } from '../src/utils'

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

// Mock OAuth2Client
const mockAuth = {} as OAuth2Client

// Mock site data
const mockSite: Site = {
  siteUrl: 'https://example.com/',
  permissionLevel: 'owner',
}

const mockSites: searchconsole_v1.Schema$WmxSite[] = [
  {
    siteUrl: 'https://example.com/',
    permissionLevel: 'owner',
  },
  {
    siteUrl: 'https://test.com/',
    permissionLevel: 'full',
  },
]

const mockSitemaps: searchconsole_v1.Schema$WmxSitemap[] = [
  {
    path: 'https://example.com/sitemap.xml',
    lastSubmitted: '2024-01-01',
    isPending: false,
    isSitemapsIndex: false,
    type: 'urlset',
    lastDownloaded: '2024-01-01',
  },
]

describe('aPI Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('fetchGscSites', () => {
    it('should fetch Google Search Console sites', async () => {
      mockSitesList.mockResolvedValue({
        data: { siteEntry: mockSites },
      })

      const result = await fetchGscSites(mockAuth)

      expect(mockSitesList).toHaveBeenCalledWith()
      expect(result).toEqual(mockSites)
    })

    it('should return empty array when no sites found', async () => {
      mockSitesList.mockResolvedValue({
        data: {},
      })

      const result = await fetchGscSites(mockAuth)

      expect(result).toEqual([])
    })
  })

  describe('fetchGscSitesWithSitemaps', () => {
    it('should fetch sites with sitemaps for owners', async () => {
      mockSitesList.mockResolvedValue({
        data: { siteEntry: mockSites },
      })

      mockSitemapsList.mockResolvedValue({
        data: { sitemap: mockSitemaps },
      })

      const result = await fetchGscSitesWithSitemaps(mockAuth)

      expect(result).toHaveLength(2)
      expect(result[0]).toHaveProperty('sitemaps')
      expect(result[0].sitemaps).toEqual(mockSitemaps)
      expect(result[1].sitemaps).toEqual([]) // non-owner should have empty sitemaps
    })

    it('should filter out unverified users', async () => {
      const sitesWithUnverified = [
        ...mockSites,
        {
          siteUrl: 'https://unverified.com/',
          permissionLevel: 'siteUnverifiedUser',
        },
      ]

      mockSitesList.mockResolvedValue({
        data: { siteEntry: sitesWithUnverified },
      })

      mockSitemapsList.mockResolvedValue({
        data: { sitemap: [] },
      })

      const result = await fetchGscSitesWithSitemaps(mockAuth)

      expect(result).toHaveLength(2) // unverified user should be filtered out
      expect(result.every(site => site.permissionLevel !== 'siteUnverifiedUser')).toBe(true)
    })
  })

  describe('inspectGscUrl', () => {
    it('should inspect URL and return indexing status', async () => {
      const mockInspection = {
        inspectionResult: {
          indexStatusResult: {
            verdict: 'PASS',
          },
        },
      }

      mockUrlInspect.mockResolvedValue({
        data: mockInspection,
      })

      const result = await inspectGscUrl(mockAuth, 'https://example.com/', 'https://example.com/page')

      expect(mockUrlInspect).toHaveBeenCalledWith({
        requestBody: {
          inspectionUrl: 'https://example.com/page',
          siteUrl: 'https://example.com/',
        },
      })
      expect(result.isIndexed).toBe(true)
      expect(result.inspection).toBeDefined()
    })

    it('should return false for non-indexed URLs', async () => {
      const mockInspection = {
        inspectionResult: {
          indexStatusResult: {
            verdict: 'FAIL',
          },
        },
      }

      mockUrlInspect.mockResolvedValue({
        data: mockInspection,
      })

      const result = await inspectGscUrl(mockAuth, 'https://example.com/', 'https://example.com/page')

      expect(result.isIndexed).toBe(false)
    })
  })
})

describe('search Analytics Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const mockRange = {
    period: {
      start: new Date('2024-01-01'),
      end: new Date('2024-01-31'),
    },
    prevPeriod: {
      start: new Date('2023-12-01'),
      end: new Date('2023-12-31'),
    },
  }

  describe('fetchDevicesWithComparison', () => {
    it('should fetch device data with comparison', async () => {
      const mockDeviceData = [
        {
          keys: ['desktop'],
          clicks: 100,
          impressions: 1000,
          ctr: 0.1,
          position: 5.5,
        },
      ]

      mockSearchAnalyticsQuery
        .mockResolvedValueOnce({ data: { rows: mockDeviceData } })
        .mockResolvedValueOnce({ data: { rows: mockDeviceData } })

      const result = await fetchDevicesWithComparison(mockAuth, mockSite, mockRange)

      expect(result).toHaveProperty('current')
      expect(result).toHaveProperty('previous')
      expect(result).toHaveProperty('metadata')
      expect(result.current).toHaveLength(1)
      expect(result.current[0]).toHaveProperty('device', 'desktop')
      expect(result.current[0]).toHaveProperty('dimension', 'device')
      expect(result.current[0].keys).toBeNull()
    })

    it('should handle missing previous period', async () => {
      const mockDeviceData = [
        {
          keys: ['mobile'],
          clicks: 50,
          impressions: 500,
          ctr: 0.1,
          position: 6.0,
        },
      ]

      mockSearchAnalyticsQuery.mockResolvedValue({
        data: { rows: mockDeviceData },
      })

      const rangeWithoutPrev = { period: mockRange.period }
      const result = await fetchDevicesWithComparison(mockAuth, mockSite, rangeWithoutPrev)

      expect(result.previous).toEqual([])
      expect(result.metadata.previousCount).toBe(0)
    })
  })

  describe('createQueryBody', () => {
    it('should create proper query body with defaults', () => {
      const result = createQueryBody()

      expect(result).toHaveProperty('type', 'web')
      expect(result).toHaveProperty('aggregationType', 'byPage')
      expect(result).toHaveProperty('dataState', 'all')
      expect(result).toHaveProperty('rowLimit', 25000)
      expect(result).toHaveProperty('startDate')
      expect(result).toHaveProperty('endDate')
    })

    it('should apply custom options', () => {
      const options = {
        period: {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-31'),
        },
        domain: 'example.com',
        filters: [
          {
            dimension: 'query' as const,
            operator: 'contains' as const,
            expression: 'test',
          },
        ],
      }

      const result = createQueryBody(options)

      expect(result.startDate).toBe('2024-01-01')
      expect(result.endDate).toBe('2024-01-31')
      expect(result.dimensionFilterGroups).toBeDefined()
      expect(result.dimensionFilterGroups![0].filters).toHaveLength(3) // domain + anchor filter + custom filter
    })

    it('should exclude anchor links by default', () => {
      const result = createQueryBody()

      expect(result.dimensionFilterGroups![0].filters).toContainEqual({
        dimension: 'page',
        operator: 'excludingRegex',
        expression: '#',
      })
    })
  })
})

describe('utility Functions', () => {
  describe('formatDateGsc', () => {
    it('should format Date objects correctly', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const result = formatDateGsc(date)

      expect(result).toBe('2024-01-15')
    })

    it('should pass through string dates unchanged', () => {
      const dateString = '2024-01-15'
      const result = formatDateGsc(dateString)

      expect(result).toBe('2024-01-15')
    })

    it('should handle falsy values', () => {
      expect(formatDateGsc(null as any)).toBeNull()
    })
  })

  describe('percentDifference', () => {
    it('should calculate percentage difference correctly', () => {
      expect(percentDifference(120, 100)).toBeCloseTo(18.18, 2)
      expect(percentDifference(80, 100)).toBeCloseTo(-22.22, 2)
      expect(percentDifference(100, 100)).toBe(0)
    })

    it('should handle zero and undefined values', () => {
      expect(percentDifference(0, 100)).toBe(0)
      expect(percentDifference(100, 0)).toBe(0)
      expect(percentDifference(undefined, 100)).toBe(0)
      expect(percentDifference(100, undefined)).toBe(0)
    })
  })

  describe('userPeriodRange', () => {
    it('should handle "30d" period string', () => {
      const result = userPeriodRange('30d')

      expect(result).toHaveProperty('period')
      expect(result).toHaveProperty('prevPeriod')
      expect(result.period).toHaveProperty('start')
      expect(result.period).toHaveProperty('end')
      expect(result.period).toHaveProperty('startDate')
      expect(result.period).toHaveProperty('endDate')
    })

    it('should handle "7d" period string', () => {
      const result = userPeriodRange('7d')

      const daysDiff = Math.ceil((result.period.end.getTime() - result.period.start.getTime()) / (1000 * 60 * 60 * 24))
      expect(daysDiff).toBe(7)
    })

    it('should handle "all" period', () => {
      const result = userPeriodRange('all')

      // Should go back about 100 years
      const yearsDiff = result.period.end.getFullYear() - result.period.start.getFullYear()
      expect(yearsDiff).toBeCloseTo(100, -1) // Within 10 years of 100
    })

    it('should handle "max" period (GSC history ~16 months)', () => {
      const result = userPeriodRange('max')

      const daysDiff = Math.ceil((result.period.end.getTime() - result.period.start.getTime()) / (1000 * 60 * 60 * 24))
      expect(daysDiff).toBe(480) // 16 months
    })

    it('should handle month periods', () => {
      const result = userPeriodRange('2mo')

      const daysDiff = Math.ceil((result.period.end.getTime() - result.period.start.getTime()) / (1000 * 60 * 60 * 24))
      expect(daysDiff).toBe(60) // 2 months * 30 days
    })

    it('should calculate previous periods correctly', () => {
      const result = userPeriodRange('7d')

      const currentDays = Math.ceil((result.period.end.getTime() - result.period.start.getTime()) / (1000 * 60 * 60 * 24))
      // Previous period is calculated with periodDays + 1, so it's one day shorter
      const prevDays = Math.ceil((result.prevPeriod.end.getTime() - result.prevPeriod.start.getTime()) / (1000 * 60 * 60 * 24))

      expect(currentDays).toBe(7)
      expect(prevDays).toBe(6) // endPrevPeriod uses periodDays + 1
      expect(result.prevPeriod.end.getTime()).toBeLessThan(result.period.start.getTime())
    })
  })
})

describe('discriminated Union Types', () => {
  it('should narrow QueryResultRow by dimension field', () => {
    // Runtime test: verify dimension field exists
    const deviceRow: DeviceData = { dimension: 'device', device: 'desktop', keys: null }
    const pageRow: PageData = { dimension: 'page', page: '/test', keys: null }
    const keywordRow: KeywordData = { dimension: 'query', keyword: 'test', keys: null }

    expect(deviceRow.dimension).toBe('device')
    expect(pageRow.dimension).toBe('page')
    expect(keywordRow.dimension).toBe('query')

    // Type-level test: verify union narrowing works
    const row: QueryResultRow = deviceRow
    if (row.dimension === 'device') {
      expectTypeOf(row).toEqualTypeOf<DeviceData>()
      expect(row.device).toBe('desktop')
    }
  })
})

describe('aggregationType', () => {
  describe('createQueryBody with aggregationType', () => {
    it('should default to byPage aggregation', () => {
      const result = createQueryBody()
      expect(result.aggregationType).toBe('byPage')
    })

    it('should accept byProperty aggregation', () => {
      const result = createQueryBody({ aggregationType: 'byProperty' })
      expect(result.aggregationType).toBe('byProperty')
    })

    it('should include page filters for byPage aggregation', () => {
      const result = createQueryBody({ aggregationType: 'byPage' })
      const filters = result.dimensionFilterGroups?.[0]?.filters || []
      const hasPageFilter = filters.some(f => f.dimension === 'page')
      expect(hasPageFilter).toBe(true)
    })

    it('should exclude page filters for byProperty aggregation', () => {
      const result = createQueryBody({ aggregationType: 'byProperty' })
      // byProperty should not add default page filters
      expect(result.dimensionFilterGroups).toBeUndefined()
    })

    it('should exclude page filters but keep custom filters for byProperty', () => {
      const result = createQueryBody({
        aggregationType: 'byProperty',
        filters: [{ dimension: 'query', operator: 'contains', expression: 'test' }],
      })
      const filters = result.dimensionFilterGroups?.[0]?.filters || []
      expect(filters).toHaveLength(1)
      expect(filters[0].dimension).toBe('query')
    })

    it('should include domain filter only for byPage', () => {
      const byPage = createQueryBody({ aggregationType: 'byPage', domain: 'example.com' })
      const byProperty = createQueryBody({ aggregationType: 'byProperty', domain: 'example.com' })

      const byPageFilters = byPage.dimensionFilterGroups?.[0]?.filters || []
      const byPropertyFilters = byProperty.dimensionFilterGroups?.[0]?.filters || []

      const byPageHasDomainFilter = byPageFilters.some(f => f.operator === 'includingRegex')
      const byPropertyHasDomainFilter = byPropertyFilters.some(f => f.operator === 'includingRegex')

      expect(byPageHasDomainFilter).toBe(true)
      expect(byPropertyHasDomainFilter).toBe(false)
    })
  })

  describe('withPropertyAggregation helper', () => {
    it('should return byProperty aggregationType', () => {
      const result = withPropertyAggregation()
      expect(result).toEqual({ aggregationType: 'byProperty' })
    })

    it('should work with spread in createQueryBody', () => {
      const result = createQueryBody({ ...withPropertyAggregation() })
      expect(result.aggregationType).toBe('byProperty')
    })
  })

  describe('aggregationType type narrowing', () => {
    it('should narrow AggregationType union', () => {
      const byPage: AggregationType = 'byPage'
      const byProperty: AggregationType = 'byProperty'

      expect(byPage).toBe('byPage')
      expect(byProperty).toBe('byProperty')

      // Type narrowing test
      const agg: AggregationType = 'byProperty'
      if (agg === 'byProperty') {
        expectTypeOf(agg).toEqualTypeOf<'byProperty'>()
      }
    })
  })
})
