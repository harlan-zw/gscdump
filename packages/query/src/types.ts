import type { GscDb } from '@gscdump/db'
import type {
  Auth,
  ComparisonResult,
  CountryData,
  DatesComparisonResult,
  DeviceData,
  FetchKeywordResult,
  FetchPageResult,
  KeywordData,
  Page,
  PageData,
  ResolvedAnalyticsRange,
  SearchAppearanceData,
} from 'gscdump'
import type { DateMetrics, QueryPageRow } from './analysis/types'

// Re-export for convenience
export type { DateMetrics, QueryPageRow }

export type DataSource = 'api' | 'db' | 'auto'

export type { FetchKeywordResult, FetchPageResult }

export interface DataProvider {
  source: 'api' | 'db'

  // Core comparison queries
  getDatesWithComparison: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<DatesComparisonResult>
  getPages: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<Page[]>
  getPagesWithComparison: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<ComparisonResult<PageData>>
  getKeywordsWithComparison: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<ComparisonResult<KeywordData>>
  getCountriesWithComparison: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<ComparisonResult<CountryData>>
  getDevicesWithComparison: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<ComparisonResult<DeviceData>>

  // Drill-down queries
  getPage: (siteUrl: string, range: ResolvedAnalyticsRange, path: string) => Promise<FetchPageResult>
  getKeyword: (siteUrl: string, range: ResolvedAnalyticsRange, keyword: string) => Promise<FetchKeywordResult>

  // API-only (optional)
  getSearchAppearanceWithComparison?: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<ComparisonResult<SearchAppearanceData>>

  // Analysis-specific queries (optional)
  getQueryPageRows?: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<QueryPageRow[]>
  getDateRows?: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<DateMetrics[]>
}

export interface QueryContext {
  auth: Auth
  db?: GscDb | null
  source?: DataSource
}

export interface CreateProviderOptions {
  auth: Auth
  db?: GscDb | null
  source: DataSource
  siteUrls: string[]
  range: ResolvedAnalyticsRange
}
