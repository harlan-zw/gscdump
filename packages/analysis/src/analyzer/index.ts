/**
 * Analyzer contracts. Engine adapter packages import from here to build
 * Analyzer instances that dispatch via `runAnalyzerFromSource`.
 */

export { bayesianCtrAnalyzer } from '../analyzers/bayesian-ctr'
export type { BayesianCtrResult } from '../analyzers/bayesian-ctr'
export { bipartitePagerankAnalyzer } from '../analyzers/bipartite-pagerank'
export type { BipartitePagerankNode, BipartitePagerankResult } from '../analyzers/bipartite-pagerank'
export { brandAnalyzer } from '../analyzers/brand'
export type {
  BrandResultRow,
  BrandSegmentationOptions,
  BrandSegmentationResult,
  BrandSummary,
} from '../analyzers/brand'
export { cannibalizationAnalyzer } from '../analyzers/cannibalization'
export type {
  CannibalizationCompetitor,
  CannibalizationEvent,
  CannibalizationOptions,
  CannibalizationPage,
  CannibalizationResult,
  CannibalizationSortMetric,
} from '../analyzers/cannibalization'
export { changePointAnalyzer } from '../analyzers/change-point'
export type { ChangePointResult, ChangePointSeriesPoint } from '../analyzers/change-point'
export { clusteringAnalyzer } from '../analyzers/clustering'
export type {
  ClusteringOptions,
  ClusteringResult,
  ClusterType,
  KeywordCluster,
} from '../analyzers/clustering'
export { concentrationAnalyzer } from '../analyzers/concentration'
export type {
  ConcentrationInput,
  ConcentrationItem,
  ConcentrationOptions,
  ConcentrationResult,
  ConcentrationRiskLevel,
} from '../analyzers/concentration'
export { contentVelocityAnalyzer } from '../analyzers/content-velocity'
export type { ContentVelocityWeek } from '../analyzers/content-velocity'
export { ctrAnomalyAnalyzer } from '../analyzers/ctr-anomaly'
export type { CtrAnomalyResult, CtrAnomalySeriesPoint } from '../analyzers/ctr-anomaly'
export { ctrCurveAnalyzer } from '../analyzers/ctr-curve'
export type { CtrCurveBucket, CtrCurveOutlier } from '../analyzers/ctr-curve'
export { darkTrafficAnalyzer } from '../analyzers/dark-traffic'
export type { DarkTrafficResult } from '../analyzers/dark-traffic'
export { dataDetailAnalyzer } from '../analyzers/data-detail'
export type { DataDetailResult } from '../analyzers/data-detail'
export { dataQueryAnalyzer } from '../analyzers/data-query'
export type { DataQueryResult } from '../analyzers/data-query'
export { decayAnalyzer } from '../analyzers/decay'
export type {
  DecayInput,
  DecayOptions,
  DecayResult,
  DecaySeriesPoint,
  DecaySortMetric,
} from '../analyzers/decay'
export { deviceGapAnalyzer } from '../analyzers/device-gap'
export type { DeviceGapResult } from '../analyzers/device-gap'
export { intentAtlasAnalyzer } from '../analyzers/intent-atlas'
export type { IntentAtlasResult } from '../analyzers/intent-atlas'
export { keywordBreadthAnalyzer } from '../analyzers/keyword-breadth'
export type { KeywordBreadthResult } from '../analyzers/keyword-breadth'
export { longTailAnalyzer } from '../analyzers/long-tail'
export type { LongTailResult } from '../analyzers/long-tail'
export { moversAnalyzer } from '../analyzers/movers'
export type {
  MoverData,
  MoversInput,
  MoversOptions,
  MoversResult,
  MoversResultRow,
  MoversSeriesPoint,
  MoversSortMetric,
} from '../analyzers/movers'
export { opportunityAnalyzer } from '../analyzers/opportunity'
export type { OpportunityResult } from '../analyzers/opportunity'
export { positionDistributionAnalyzer } from '../analyzers/position-distribution'
export type { PositionDistributionResult } from '../analyzers/position-distribution'
export { positionVolatilityAnalyzer } from '../analyzers/position-volatility'
export type { PositionVolatilityDay, PositionVolatilityResult } from '../analyzers/position-volatility'
export { queryMigrationAnalyzer } from '../analyzers/query-migration'
export type { QueryMigrationExample, QueryMigrationResult } from '../analyzers/query-migration'
export { seasonalityAnalyzer } from '../analyzers/seasonality'
export type {
  MonthlyData,
  SeasonalityMetric,
  SeasonalityOptions,
  SeasonalityResult,
} from '../analyzers/seasonality'
export { stlDecomposeAnalyzer } from '../analyzers/stl-decompose'
export type { StlDecomposeResult, StlDecomposeSeriesPoint } from '../analyzers/stl-decompose'
export { strikingDistanceAnalyzer } from '../analyzers/striking-distance'
export type { StrikingDistanceInputRow, StrikingDistanceResult } from '../analyzers/striking-distance'
export { survivalAnalyzer } from '../analyzers/survival'
export type { SurvivalCurvePoint, SurvivalResult } from '../analyzers/survival'
export { trendsAnalyzer } from '../analyzers/trends'
export type { TrendCategory, TrendSeriesPoint, TrendsResult } from '../analyzers/trends'
export { zeroClickAnalyzer } from '../analyzers/zero-click'
export type { ZeroClickResult } from '../analyzers/zero-click'
export {
  datesQueryState,
  queriesQueryState,
  pagesQueryState,
} from './adapt-rows'
export {
  clampLimit,
  clampOffset,
  paginateClause,
  paginateInMemory,
  resolveSort,
} from './paginate'
export type { PaginateInput } from './paginate'
