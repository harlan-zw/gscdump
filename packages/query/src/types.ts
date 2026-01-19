import type { GscDb } from '@gscdump/db'
import type {
  Auth,
  CannibalizationOptions,
  CannibalizationResult,
  ComparisonResult,
  CountryData,
  DatesComparisonResult,
  DecayOptions,
  DecayResult,
  DeviceData,
  FetchKeywordResult,
  FetchPageResult,
  KeywordData,
  MoversOptions,
  MoversResult,
  Page,
  PageData,
  ResolvedAnalyticsRange,
  SearchAppearanceData,
  SeasonalityOptions,
  SeasonalityResult,
  StrikingDistanceOptions,
  StrikingDistanceResult,
  ZeroClickOptions,
  ZeroClickResult,
} from 'gscdump'
import type { DateMetrics, QueryPageRow } from './analysis/types'

// Re-export for convenience
export type { DateMetrics, QueryPageRow }

export type DataSource = 'api' | 'db' | 'hybrid'

export type { FetchKeywordResult, FetchPageResult }

export interface DataProvider {
  source: DataSource

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

  // Sync methods (hybrid provider only)
  sync?: () => Promise<void>
  discard?: () => void
  pending?: () => number
}

export interface ProviderOptions {
  auth?: Auth
  db?: GscDb
}
