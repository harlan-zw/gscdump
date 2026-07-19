// `analyzeActionPriority` / `analyzeActionPriorityFromSource` were removed;
// callers should `runReport({ id: 'priority' })` from `@gscdump/analysis/report`.
// Domain types + scoring helpers stay public for advanced consumers
// reimplementing the composition.
export type {
  ActionPriorityResult,
  ActionPrioritySourceState,
  ActionPrioritySourceStatus,
  ActionSource,
  Effort,
  PriorityAction,
} from './action-priority'
export {
  DEFAULT_PRIORITY_SOURCES,
  mergePriorityActions,
  normalizePriorityActions,
  scorePriorityActions,
} from './action-priority'

export { ROW_ANALYZERS } from './analyzer/row-analyzers'
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

export { analyzeMovers } from './analyzers/movers'
export type { OpportunityFactors, OpportunityOptions, OpportunityResult, OpportunitySortMetric, OpportunityWeights } from './analyzers/opportunity'
export { analyzeOpportunity } from './analyzers/opportunity'
export type { MonthlyData, SeasonalityMetric, SeasonalityOptions, SeasonalityResult } from './analyzers/seasonality'
export { analyzeSeasonality } from './analyzers/seasonality'
export type { StrikingDistanceInputRow, StrikingDistanceOptions, StrikingDistanceResult } from './analyzers/striking-distance'
export { analyzeStrikingDistance } from './analyzers/striking-distance'
export type { ZeroClickOptions, ZeroClickResult } from './analyzers/zero-click'
export { analyzeZeroClick } from './analyzers/zero-click'
export { analyzeInBrowser, rewriteForTableSource } from './browser'

export type { AnalyzerRunner, BrowserAnalyzeOptions } from './browser'

export { defaultAnalyzerRegistry } from './default-registry'

// Typed, caller-actionable analysis failures (the `E` channel for the report /
// analyzer boundary). Pairs with `Result` from `gscdump/result`.
export type { AnalysisError, AnalysisErrorKind } from './errors'
export {
  analysisErrors,
  analysisErrorToException,
  formatAnalysisError,
  isAnalysisError,
} from './errors'

export { classifyQueryIntent, decodeIntent, encodeIntent, INTENT_CLASSIFIER_VERSION, SEARCH_INTENT_CODE } from './query/intent'
export type { IntentClassification, SearchIntent } from './query/intent'
export { normalizeQuery, NORMALIZER_VERSION } from './query/normalize'

// Reports — public surface. `defineReport` lives at `@gscdump/engine/report`
// so the contract is readable without pulling the runtime in.
export {
  defaultReportRegistry,
  dryRunReport,
  formatReport,
  REPORTS,
  runReport,
  runReportResult,
} from './report'
export type {
  DryRunReportResult,
  FormatReportOptions,
  RunReportOptions,
} from './report'

export type {
  SitemapDelta,
  SitemapHealthDiff,
  SitemapHealthInput,
  SitemapHealthRow,
  SitemapHealthTotals,
} from './sitemap-health'
export { diffSitemapHealth } from './sitemap-health'
// Source factories. The dispatcher is `runAnalyzerFromSource` (re-exported
// below from `@gscdump/engine/analyzer`).
export {
  createCompositeSource,
  createInMemoryQuerySource,
  IN_MEMORY_DEFAULT_CAPABILITIES,
} from './source'
export type {
  CompositeSourceOptions,
  InMemoryQuerySourceOptions,
} from './source'
export { SQL_ANALYZERS } from './sql-analyzers'
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
  ReportAction,
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
