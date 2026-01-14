import type { searchconsole_v1 } from '@googleapis/searchconsole/v1'

export const mockSites: searchconsole_v1.Schema$WmxSite[] = [
  {
    siteUrl: 'https://example.com/',
    permissionLevel: 'owner',
  },
  {
    siteUrl: 'sc-domain:example.com',
    permissionLevel: 'owner',
  },
  {
    siteUrl: 'https://test.example.com/',
    permissionLevel: 'full',
  },
]

export const mockSitemaps: searchconsole_v1.Schema$WmxSitemap[] = [
  {
    path: 'https://example.com/sitemap.xml',
    lastSubmitted: '2024-01-15T10:30:00.000Z',
    isPending: false,
    isSitemapsIndex: true,
    type: 'urlset',
    lastDownloaded: '2024-01-15T11:00:00.000Z',
    warnings: 0,
    errors: 0,
  },
  {
    path: 'https://example.com/sitemap-posts.xml',
    lastSubmitted: '2024-01-15T10:30:00.000Z',
    isPending: false,
    isSitemapsIndex: false,
    type: 'urlset',
    lastDownloaded: '2024-01-15T11:00:00.000Z',
    warnings: 0,
    errors: 0,
  },
]

export const mockUrlInspection: searchconsole_v1.Schema$InspectUrlIndexResponse = {
  inspectionResult: {
    inspectionResultLink: 'https://search.google.com/search-console/inspect',
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      lastCrawlTime: '2024-01-15T10:30:00.000Z',
      pageFetchState: 'SUCCESSFUL',
      googleCanonical: 'https://example.com/page',
      userCanonical: 'https://example.com/page',
    },
    mobileUsabilityResult: {
      verdict: 'PASS',
    },
    richResultsResult: {
      verdict: 'PASS',
      detectedItems: [
        {
          richResultType: 'Article',
          items: ['Article markup found'],
        },
      ],
    },
  },
}

export const mockDeviceData: searchconsole_v1.Schema$ApiDataRow[] = [
  {
    keys: ['desktop'],
    clicks: 1250.0,
    impressions: 12580.0,
    ctr: 0.0994,
    position: 8.2,
  },
  {
    keys: ['mobile'],
    clicks: 2100.0,
    impressions: 18420.0,
    ctr: 0.1140,
    position: 6.8,
  },
  {
    keys: ['tablet'],
    clicks: 150.0,
    impressions: 1680.0,
    ctr: 0.0893,
    position: 9.1,
  },
]

export const mockCountryData: searchconsole_v1.Schema$ApiDataRow[] = [
  {
    keys: ['usa'],
    clicks: 2800.0,
    impressions: 22400.0,
    ctr: 0.1250,
    position: 7.2,
  },
  {
    keys: ['gbr'],
    clicks: 420.0,
    impressions: 3360.0,
    ctr: 0.1250,
    position: 7.5,
  },
  {
    keys: ['can'],
    clicks: 280.0,
    impressions: 2520.0,
    ctr: 0.1111,
    position: 8.1,
  },
]

export const mockKeywordData: searchconsole_v1.Schema$ApiDataRow[] = [
  {
    keys: ['best practices'],
    clicks: 450.0,
    impressions: 3600.0,
    ctr: 0.1250,
    position: 4.2,
  },
  {
    keys: ['how to guide'],
    clicks: 380.0,
    impressions: 4560.0,
    ctr: 0.0833,
    position: 5.8,
  },
  {
    keys: ['tutorial'],
    clicks: 290.0,
    impressions: 2900.0,
    ctr: 0.1000,
    position: 6.1,
  },
]

export const mockPageData: searchconsole_v1.Schema$ApiDataRow[] = [
  {
    keys: ['https://example.com/'],
    clicks: 1200.0,
    impressions: 8400.0,
    ctr: 0.1429,
    position: 3.2,
  },
  {
    keys: ['https://example.com/guide'],
    clicks: 800.0,
    impressions: 6400.0,
    ctr: 0.1250,
    position: 4.8,
  },
  {
    keys: ['https://example.com/blog'],
    clicks: 650.0,
    impressions: 5850.0,
    ctr: 0.1111,
    position: 5.5,
  },
]

export const mockAnalyticsData: searchconsole_v1.Schema$ApiDataRow[] = [
  {
    keys: [],
    clicks: 3500.0,
    impressions: 32680.0,
    ctr: 0.1071,
    position: 7.4,
  },
]

export const mockDateData: searchconsole_v1.Schema$ApiDataRow[] = [
  {
    keys: ['2024-01-01'],
    clicks: 120.0,
    impressions: 1080.0,
    ctr: 0.1111,
    position: 7.2,
  },
  {
    keys: ['2024-01-02'],
    clicks: 135.0,
    impressions: 1215.0,
    ctr: 0.1111,
    position: 7.1,
  },
  {
    keys: ['2024-01-03'],
    clicks: 110.0,
    impressions: 1100.0,
    ctr: 0.1000,
    position: 7.5,
  },
]
