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
export type { BrandSegmentationOptions, BrandSegmentationResult, BrandSummary } from './brand'
export { analyzeBrandSegmentation } from './brand'
export type { ClusteringOptions, ClusteringResult, ClusterType, KeywordCluster } from './clustering'
export { analyzeClustering } from './clustering'
export type {
  ConcentrationInput,
  ConcentrationItem,
  ConcentrationOptions,
  ConcentrationResult,
  ConcentrationRiskLevel,
} from './concentration'

export { analyzeConcentration, analyzeKeywordConcentration, analyzePageConcentration } from './concentration'

export type { DecayInput, DecayOptions, DecayResult, DecaySortMetric } from './decay'
export { analyzeDecay } from './decay'

export { defaultAnalyzerRegistry } from './default-registry'

export type { MoverData, MoversInput, MoversOptions, MoversResult, MoversSortMetric } from './movers'
export { analyzeMovers } from './movers'

export type {
  OpportunityFactors,
  OpportunityOptions,
  OpportunityResult,
  OpportunitySortMetric,
  OpportunityWeights,
} from './opportunity'
export { analyzeOpportunity } from './opportunity'

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

export type { MonthlyData, SeasonalityMetric, SeasonalityOptions, SeasonalityResult } from './seasonality'
export { analyzeSeasonality } from './seasonality'

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
  SortOrder,
} from './types'
export { createSorter, num } from './types'
