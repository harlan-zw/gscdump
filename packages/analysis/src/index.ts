export type {
  ActionPriorityAnalyzer,
  ActionPriorityResult,
  ActionPriorityRunOptions,
  ActionPrioritySourceState,
  ActionPrioritySourceStatus,
  ActionSource,
  Effort,
  PriorityAction,
} from './action-priority'
export {
  analyzeActionPriority,
  analyzeActionPriorityFromSource,
  mergePriorityActions,
  normalizePriorityActions,
  scorePriorityActions,
} from './action-priority'

export { ROW_ANALYZERS } from './analyzer/row-analyzers'
// Pure analysis functions
export type { BrandSegmentationOptions, BrandSegmentationResult, BrandSummary } from './analyzers/brand'
export { analyzeBrandSegmentation } from './analyzers/brand'

export type {
  CannibalizationCompetitor,
  CannibalizationEvent,
  CannibalizationOptions,
  CannibalizationPage,
  CannibalizationResult,
  CannibalizationSortMetric,
} from './analyzers/cannibalization'
export { analyzeCannibalization } from './analyzers/cannibalization'

export type { ClusteringOptions, ClusteringResult, ClusterType, KeywordCluster } from './analyzers/clustering'
export { analyzeClustering } from './analyzers/clustering'

export type {
  ConcentrationInput,
  ConcentrationItem,
  ConcentrationOptions,
  ConcentrationResult,
  ConcentrationRiskLevel,
} from './analyzers/concentration'
export { analyzeConcentration, analyzeKeywordConcentration, analyzePageConcentration } from './analyzers/concentration'

export type { DecayInput, DecayOptions, DecayResult, DecaySeriesPoint, DecaySortMetric } from './analyzers/decay'
export { analyzeDecay } from './analyzers/decay'

export type { MoverData, MoversInput, MoversOptions, MoversResult, MoversSortMetric } from './analyzers/movers'

export { analyzeMovers } from './analyzers/movers'
export type { OpportunityResult } from './analyzers/opportunity'
export type { MonthlyData, SeasonalityMetric, SeasonalityOptions, SeasonalityResult } from './analyzers/seasonality'
export { analyzeSeasonality } from './analyzers/seasonality'
export type { ZeroClickResult } from './analyzers/zero-click'
// Browser dispatcher (legacy AnalyzerSpec path)
export { analyzeInBrowser, rewriteForTableSource } from './browser'
export type { AnalyzerRunner, BrowserAnalyzeOptions } from './browser'

export { defaultAnalyzerRegistry } from './default-registry'

export { normalizeQuery } from './query/normalize'
// Source-based analyzer entrypoints
export type {
  ComparisonQueryResult,
  QueryDimension,
  QueryOptions,
  QueryResult,
} from './source'

export {
  analyzeBrandSegmentationFromSource,
  analyzeClusteringFromSource,
  analyzeDecayFromSource,
  analyzeFromSource,
  analyzeKeywordConcentrationFromSource,
  analyzeMoversFromSource,
  analyzeOpportunityFromSource,
  analyzePageConcentrationFromSource,
  analyzeSeasonalityFromSource,
  analyzeStrikingDistanceFromSource,
  createCompositeSource,
  createInMemoryQuerySource,
  IN_MEMORY_DEFAULT_CAPABILITIES,
  queryAnalyticsFromSource,
  queryComparisonFromSource,
} from './source'
export type {
  CompositeSourceOptions,
  InMemoryQuerySourceOptions,
} from './source'

export { SQL_ANALYZERS } from './sql-analyzers'

export type {
  StrikingDistanceOptions,
  StrikingDistanceResult,
  StrikingDistanceSortMetric,
} from './striking-distance'
export { analyzeStrikingDistance } from './striking-distance'
// Domain row shapes + utilities
export type {
  BaseMetrics,
  DateRow,
  KeywordRow,
  PageRow,
  QueryPageRow,
  SortOrder,
} from './types'

export { createSorter } from './types'
// Analyzer call contracts
export type {
  AnalysisParams,
  AnalysisResult,
  AnalysisTool,
} from '@gscdump/engine/analysis-types'

export { num } from '@gscdump/engine/analysis-types'

// Analyzer contracts + dispatcher (lifted to @gscdump/engine, re-exported here as the public surface)
export type {
  Analyzer,
  AnalyzerRegistry,
  AnalyzerRegistryInit,
  AnalyzerVariants,
  Capability,
  Plan,
  ReduceContext,
  RowQueriesPlan,
  SqlExtraQuery,
  SqlPlan,
  TypedRowQuery,
} from '@gscdump/engine/analyzer'

export {
  AnalyzerCapabilityError,
  createAnalyzerRegistry,
  defineAnalyzer,
  runAnalyzerFromSource,
} from '@gscdump/engine/analyzer'

export type {
  DefineAnalyzerOptions,
  DefinedAnalyzer,
  ReduceCtx,
  Reducer,
  SqlPlanSpec,
} from '@gscdump/engine/analyzer'
// Period helpers
export type {
  AnalysisPeriod,
  ComparisonMode,
  ComparisonPeriod,
  PadTimeseriesOptions,
  ResolvedWindow,
  ResolveWindowOptions,
  WindowPreset,
} from '@gscdump/engine/period'

export {
  comparisonOf,
  padTimeseries,
  periodOf,
  resolveWindow,
  windowToComparisonPeriod,
  windowToPeriod,
} from '@gscdump/engine/period'

// Source contracts (resolver-owned)
export type {
  AnalysisQuerySource,
  ExecuteSqlOptions,
  FileSet,
  QueryRow,
  RowQuerySource,
  SourceCapabilities,
  SqlQuerySource,
} from '@gscdump/engine/resolver'
export { isSqlQuerySource } from '@gscdump/engine/resolver'

// Engine-backed source + typed-query helpers
export type {
  EngineQuerySourceOptions,
  TypedQuery,
} from '@gscdump/engine/source'
export {
  createEngineQuerySource,
  ENGINE_QUERY_CAPABILITIES,
  queryComparisonRows,
  queryRows,
  runAnalyzerWithEngine,
  typedQuery,
} from '@gscdump/engine/source'
