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

export {
  AnalyzerCapabilityError,
  runAnalyzerFromSource,
} from './analyzer/dispatch'
export type { AnalyzerRegistry, AnalyzerRegistryInit, AnalyzerVariants } from './analyzer/registry'
export { createAnalyzerRegistry } from './analyzer/registry'
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

export type {
  AnalysisPeriod,
  ComparisonMode,
  ComparisonPeriod,
  PadTimeseriesOptions,
  ResolvedWindow,
  ResolveWindowOptions,
  WindowPreset,
} from './period'
export {
  comparisonOf,
  padTimeseries,
  periodOf,
  resolveWindow,
  windowToComparisonPeriod,
  windowToPeriod,
} from './period'

export { normalizeQuery } from './query/normalize'
// Source-based analyzer entrypoints
export type {
  AnalysisQuerySource,
  ComparisonQueryResult,
  QueryDimension,
  QueryOptions,
  QueryResult,
  QueryRow,
  RowQuerySource,
  SourceCapabilities,
  SqlQuerySource,
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
  createBrowserQuerySource,
  createEngineQuerySource,
  createGscApiQuerySource,
  createInMemoryQuerySource,
  createSqliteQuerySource,
  isSqlQuerySource,
  queryAnalyticsFromSource,
  queryComparisonFromSource,
  queryComparisonRows,
  queryRows,
} from './source'
export { runAnalyzerWithEngine } from './source/engine'

export type {
  StrikingDistanceOptions,
  StrikingDistanceResult,
  StrikingDistanceSortMetric,
} from './striking-distance'
export { analyzeStrikingDistance } from './striking-distance'
// Analyzer contract types (used by CLI, MCP, cloud)
export type {
  AnalysisParams,
  AnalysisResult,
  AnalysisTool,
  BaseMetrics,
  DateRow,
  KeywordRow,
  PageRow,
  QueryPageRow,
  SortOrder,
} from './types'

export { createSorter, num } from './types'
