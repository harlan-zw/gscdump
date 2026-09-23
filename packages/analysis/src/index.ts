// Pure analysis functions
export type { BrandSegmentationOptions, BrandSegmentationResult, BrandSegmentationRow, BrandSummary } from './analyzers/brand'
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

export { analyzeMovers, MOVERS_SORT_METRICS } from './analyzers/movers'
export type { OpportunityFactors, OpportunityOptions, OpportunityResult, OpportunitySortMetric, OpportunityWeights } from './analyzers/opportunity'
export { analyzeOpportunity } from './analyzers/opportunity'
export type { MonthlyData, SeasonalityMetric, SeasonalityOptions, SeasonalityResult } from './analyzers/seasonality'
export { analyzeSeasonality } from './analyzers/seasonality'
export type { StrikingDistanceInputRow, StrikingDistanceOptions, StrikingDistanceResult } from './analyzers/striking-distance'
export { analyzeStrikingDistance } from './analyzers/striking-distance'
export type { ZeroClickOptions, ZeroClickResult } from './analyzers/zero-click'
export { analyzeZeroClick } from './analyzers/zero-click'
export { analyzeInBrowser } from './browser'

export type { AnalyzerRunner, BrowserAnalyzeOptions } from './browser'

export { classifyQueryIntent, encodeIntent, INTENT_CLASSIFIER_VERSION, SEARCH_INTENT_CODE } from './query/intent'
export type { IntentClassification, SearchIntent } from './query/intent'
export { normalizeQuery, NORMALIZER_VERSION } from './query/normalize'

export type {
  CurrentSitemapScope,
  SitemapCollapsePolicy,
  SitemapCollapseState,
  SitemapDelta,
  SitemapHealthDiff,
  SitemapHealthInput,
  SitemapHealthRow,
  SitemapHealthTotals,
} from './sitemap-health'
export {
  classifySitemapCollapse,
  compareCurrentSitemapScope,
  diffSitemapHealth,
  SITEMAP_SYNC_COLLAPSE_POLICY,
  SITEMAP_TRUST_COLLAPSE_POLICY,
  sitemapHistoryHasCollapse,
} from './sitemap-health'
// Domain row shapes + utilities
export type {
  BaseMetrics,
  DateRow,
  PageRow,
  QueriesRow,
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
  Plan,
  ReduceContext,
  RequiredCapability,
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
} from '@gscdump/engine/period'

export type {
  DefinedReport,
  DefineReportOptions,
  ReportContext,
  ReportFinding,
  ReportPlanStep,
  ReportResult,
  ReportSection,
} from '@gscdump/engine/report'
// Source contracts + engine-backed source + typed-query helpers
export type {
  AnalysisQuerySource,
  AnalysisSourceKind,
  EngineQuerySourceOptions,
  ExecuteSqlOptions,
  FileSet,
  QueryRow,
  SourceCapabilities,
} from '@gscdump/engine/source'
export {
  createEngineQuerySource,
  ENGINE_QUERY_CAPABILITIES,
  queryRows,
  runAnalyzerWithEngine,
} from '@gscdump/engine/source'
