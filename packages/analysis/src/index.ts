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

// Query periods and fetch wrappers
export type {
  AnalysisPeriod,
  ComparisonPeriod,
  ComparisonQueryResult,
  QueryDimension,
  QueryOptions,
  QueryResult,
} from './fetch'
export {
  fetchBrandSegmentation,
  fetchClustering,
  fetchDecay,
  fetchKeywordConcentration,
  fetchMovers,
  fetchOpportunity,
  fetchPageConcentration,
  fetchSeasonality,
  fetchStrikingDistance,
} from './fetch'

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

export type { PadTimeseriesOptions } from './pad-timeseries'
export { padTimeseries } from './pad-timeseries'

export type { MonthlyData, SeasonalityMetric, SeasonalityOptions, SeasonalityResult } from './seasonality'
export { analyzeSeasonality } from './seasonality'

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
