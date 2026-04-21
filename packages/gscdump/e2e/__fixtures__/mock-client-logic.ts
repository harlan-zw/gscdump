import type { searchconsole_v1 } from '@googleapis/searchconsole/build/v1'
import type { GoogleSearchConsoleClient } from '../../src/client'
import { vi } from 'vitest'
import {
  mockAnalyticsData,
  mockCountryData,
  mockDateData,
  mockDeviceData,
  mockKeywordData,
  mockPageData,
  mockSitemaps,
  mockSites,
  mockUrlInspection,
} from './mock-responses'

export function defaultQueryImplementation(_siteUrl: string, body: any): Promise<searchconsole_v1.Schema$SearchAnalyticsQueryResponse> {
  // Simple logic to return different data based on dimensions
  // This makes the mock more "intelligent" and stable for general purpose tests
  if (body.dimensions?.includes('date'))
    return Promise.resolve({ rows: mockDateData })
  if (body.dimensions?.includes('device'))
    return Promise.resolve({ rows: mockDeviceData })
  if (body.dimensions?.includes('country'))
    return Promise.resolve({ rows: mockCountryData })
  if (body.dimensions?.includes('page'))
    return Promise.resolve({ rows: mockPageData })
  if (body.dimensions?.includes('query'))
    return Promise.resolve({ rows: mockKeywordData })
  return Promise.resolve({ rows: mockAnalyticsData })
}

export function createMockGoogleSearchConsoleClient(): GoogleSearchConsoleClient {
  return {
    sites: {
      list: vi.fn().mockResolvedValue({ siteEntry: mockSites }),
    },
    sitemaps: {
      list: vi.fn().mockResolvedValue({ sitemap: mockSitemaps }),
      get: vi.fn().mockResolvedValue(mockSitemaps[0]),
      submit: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    searchAnalytics: {
      query: vi.fn().mockImplementation(defaultQueryImplementation),
    },
    urlInspection: {
      inspect: vi.fn().mockResolvedValue(mockUrlInspection),
    },
    indexing: {
      publish: vi.fn().mockResolvedValue({ urlNotificationMetadata: { latestUpdate: { notifyTime: new Date().toISOString() } } }),
      getMetadata: vi.fn().mockResolvedValue({ latestUpdate: { notifyTime: new Date().toISOString() } }),
    },
  } as unknown as GoogleSearchConsoleClient
}
