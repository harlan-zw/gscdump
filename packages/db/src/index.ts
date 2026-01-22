// API-compatible query functions
export {
  hasDataForRange,
  queryCountriesWithComparison,
  queryDateRows,
  queryDatesWithComparison,
  queryDevicesWithComparison,
  queryKeyword,
  queryKeywordsWithComparison,
  queryPage,
  queryPages,
  queryPagesWithComparison,
  queryQueryPageRows,
} from './api-queries'
export type { DateRange, DateRow, QueryPageRow } from './api-queries'

// Connector
export { createGoogleSearchConsoleDatabase } from './connector'

export type { GoogleSearchConsoleDatabase } from './connector'
// Query helpers
export {
  comparePeriods,
  findLostPages,
  findNewPages,
  findSignificantChanges,
  getAllSites,
  getCountryBreakdown,
  getDeviceBreakdown,
  getKeywordTrend,
  getPageTrend,
  getSiteById,
  getSiteByProperty,
  getSiteDailyTotals,
  getTopKeywords,
  getTopPages,
  pruneOldData,
  pruneOldDataByDays,
  queryMonthlyRollup,
  queryWeeklyRollup,
  vacuumDb,
} from './queries'

export type { LostPage, NewPage, RollupRow, SignificantChange } from './queries'
// Schema setup
export { SCHEMA_SQL, SCHEMA_STATEMENTS, setup, setupSchema } from './setup'

// Sync functions
export {
  batchInspectUrls,
  batchRequestIndexingForPaths,
  getIndexingStats,
  getLastSyncedDate,
  // Indexing
  getUrlsNeedingIndexing,
  inspectAndSyncUrl,
  requestAndSyncIndexing,
  syncSites,
  syncTables,
  toGscMetrics,
  updateLastSynced,
} from './sync'
export type { IndexingNotificationType, IndexingResult, SyncOptions, SyncResult, SyncTable } from './sync'

// Types
export type {
  ComparisonResult,
  CountryData,
  DateData,
  DatesComparisonResult,
  DeviceData,
  FetchKeywordResult,
  FetchPageResult,
  KeywordData,
  PageData,
} from './types'
