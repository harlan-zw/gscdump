export { analyzeFromSource, AnalyzerCapabilityError } from './analyze-from-source'
export { createBrowserQuerySource } from './browser'
export type { BrowserQueryRunner } from './browser'
export { createEngineQuerySource, ENGINE_QUERY_CAPABILITIES, runAnalyzerWithEngine } from './engine'
export type { EngineQuerySourceOptions } from './engine'
export { createGscApiQuerySource, GSC_API_CAPABILITIES } from './gsc'
export type { GscApiQuerySourceOptions } from './gsc'
export { createInMemoryQuerySource, IN_MEMORY_DEFAULT_CAPABILITIES } from './in-memory'
export type { InMemoryQuerySourceOptions } from './in-memory'
export {
  analyzeBrandSegmentationFromSource,
  analyzeClusteringFromSource,
  analyzeDecayFromSource,
  analyzeKeywordConcentrationFromSource,
  analyzeMoversFromSource,
  analyzeOpportunityFromSource,
  analyzePageConcentrationFromSource,
  analyzeSeasonalityFromSource,
  analyzeStrikingDistanceFromSource,
  queryAnalyticsFromSource,
  queryComparisonFromSource,
} from './portable'
export type {
  ComparisonQueryResult,
  QueryDimension,
  QueryOptions,
  QueryResult,
} from './shared-types'
export {
  createSqliteQuerySource,
} from './sqlite'
export type {
  SqliteQueryExecutor,
  SqliteQuerySourceOptions,
} from './sqlite'
export { isSqlQuerySource, queryComparisonRows, queryRows, typedQuery } from './types'
export type {
  AnalysisQuerySource,
  QueryRow,
  RowQuerySource,
  SourceCapabilities,
  SqlQuerySource,
  TypedQuery,
} from './types'
