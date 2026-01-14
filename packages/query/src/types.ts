import type { GscDb } from '@gscdump/db'
import type {
  ComparisonResult,
  CountryData,
  DatesComparisonResult,
  DeviceData,
  GscAuth,
  GscDataRow,
  KeywordData,
  Page,
  PageData,
  ResolvedAnalyticsRange,
  SearchAppearanceData,
} from 'gscdump'

export type DataSource = 'api' | 'db' | 'auto'

// Drill-down result types - aligned with actual API/DB return types
export interface PageDrillDown {
  dates: GscDataRow[]
  keywords: GscDataRow[]
}

export interface KeywordDrillDown {
  dates: GscDataRow[]
  pages: GscDataRow[]
}

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
  getPage: (siteUrl: string, range: ResolvedAnalyticsRange, path: string) => Promise<PageDrillDown>
  getKeyword: (siteUrl: string, range: ResolvedAnalyticsRange, keyword: string) => Promise<KeywordDrillDown>

  // API-only (optional)
  getSearchAppearanceWithComparison?: (siteUrl: string, range: ResolvedAnalyticsRange) => Promise<ComparisonResult<SearchAppearanceData>>
}

export interface QueryContext {
  auth: GscAuth
  db?: GscDb | null
  source?: DataSource
}

export interface CreateProviderOptions {
  auth: GscAuth
  db?: GscDb | null
  source: DataSource
  siteUrls: string[]
  range: ResolvedAnalyticsRange
}
