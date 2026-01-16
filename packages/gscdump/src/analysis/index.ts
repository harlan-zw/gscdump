/**
 * Analysis module - pure functions for GSC data analysis.
 *
 * All analysis functions operate on typed data and return typed results.
 * No client dependencies - data must be fetched separately.
 */

// Types
export * from './types'

// Pure analysis functions
export {
  analyzeStrikingDistance,
  type StrikingDistanceOptions,
  type StrikingDistanceResult,
  type StrikingDistanceSortMetric,
} from './striking-distance'

export {
  analyzeOpportunity,
  type OpportunityOptions,
  type OpportunityResult,
  type OpportunitySortMetric,
  type OpportunityWeights,
  type OpportunityFactors,
} from './opportunity'

export {
  analyzeBrandSegmentation,
  type BrandSegmentationOptions,
  type BrandSegmentationResult,
  type BrandSummary,
} from './brand'

export {
  analyzeConcentration,
  analyzePageConcentration,
  analyzeKeywordConcentration,
  type ConcentrationOptions,
  type ConcentrationResult,
  type ConcentrationItem,
  type ConcentrationInput,
  type ConcentrationRiskLevel,
} from './concentration'

export {
  analyzeDecay,
  type DecayOptions,
  type DecayResult,
  type DecayInput,
  type DecaySortMetric,
} from './decay'

export {
  analyzeMovers,
  type MoversOptions,
  type MoversResult,
  type MoversInput,
  type MoverData,
  type MoversSortMetric,
} from './movers'

export {
  analyzeCannibalization,
  type CannibalizationOptions,
  type CannibalizationResult,
  type CannibalizationPage,
  type CannibalizationSortMetric,
} from './cannibalization'

export {
  analyzeZeroClick,
  type ZeroClickOptions,
  type ZeroClickResult,
} from './zero-click'

export {
  analyzeSeasonality,
  type SeasonalityOptions,
  type SeasonalityResult,
  type SeasonalityMetric,
  type MonthlyData,
} from './seasonality'

export {
  analyzeClustering,
  type ClusteringOptions,
  type ClusteringResult,
  type KeywordCluster,
  type ClusterType,
} from './clustering'
