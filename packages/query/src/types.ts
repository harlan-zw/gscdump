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
  // Analysis types for DB-optimized methods
  StrikingDistanceOptions,
  StrikingDistanceResult,
  CannibalizationOptions,
  CannibalizationResult,
  ZeroClickOptions,
  ZeroClickResult,
  DecayOptions,
  DecayResult,
  MoversOptions,
  MoversResult,
  SeasonalityOptions,
  SeasonalityResult,
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

  // DB-optimized analysis methods (optional - DB implements with SQL, API falls back to pure functions)
  getStrikingDistanceResults?: (siteUrl: string, range: ResolvedAnalyticsRange, options?: StrikingDistanceOptions) => Promise<StrikingDistanceResult[]>
  getCannibalizationResults?: (siteUrl: string, range: ResolvedAnalyticsRange, options?: CannibalizationOptions) => Promise<CannibalizationResult[]>
  getZeroClickResults?: (siteUrl: string, range: ResolvedAnalyticsRange, options?: ZeroClickOptions) => Promise<ZeroClickResult[]>
  getDecayResults?: (siteUrl: string, range: ResolvedAnalyticsRange, options?: DecayOptions) => Promise<DecayResult[]>
  getMoversResults?: (siteUrl: string, range: ResolvedAnalyticsRange, options?: MoversOptions) => Promise<MoversResult>
  getSeasonalityResults?: (siteUrl: string, range: ResolvedAnalyticsRange, options?: SeasonalityOptions) => Promise<SeasonalityResult>
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
