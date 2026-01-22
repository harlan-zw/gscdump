/**
 * Analysis module - pure functions for GSC data analysis.
 *
 * All analysis functions operate on typed data and return typed results.
 * No client dependencies - data must be fetched separately.
 */

export {
  analyzeBrandSegmentation,
  type BrandSegmentationOptions,
  type BrandSegmentationResult,
  type BrandSummary,
} from './brand'

export {
  analyzeCannibalization,
  type CannibalizationOptions,
  type CannibalizationPage,
  type CannibalizationResult,
  type CannibalizationSortMetric,
} from './cannibalization'

export {
  analyzeClustering,
  type ClusteringOptions,
  type ClusteringResult,
  type ClusterType,
  type KeywordCluster,
} from './clustering'

export {
  analyzeConcentration,
  analyzeKeywordConcentration,
  analyzePageConcentration,
  type ConcentrationInput,
  type ConcentrationItem,
  type ConcentrationOptions,
  type ConcentrationResult,
  type ConcentrationRiskLevel,
} from './concentration'

export {
  analyzeDecay,
  type DecayInput,
  type DecayOptions,
  type DecayResult,
  type DecaySortMetric,
} from './decay'

export {
  analyzeMovers,
  type MoverData,
  type MoversInput,
  type MoversOptions,
  type MoversResult,
  type MoversSortMetric,
} from './movers'

export {
  analyzeOpportunity,
  type OpportunityFactors,
  type OpportunityOptions,
  type OpportunityResult,
  type OpportunitySortMetric,
  type OpportunityWeights,
} from './opportunity'

export {
  analyzeSeasonality,
  type MonthlyData,
  type SeasonalityMetric,
  type SeasonalityOptions,
  type SeasonalityResult,
} from './seasonality'

// Pure analysis functions
export {
  analyzeStrikingDistance,
  type StrikingDistanceOptions,
  type StrikingDistanceResult,
  type StrikingDistanceSortMetric,
} from './striking-distance'

// Types
export * from './types'

export {
  analyzeZeroClick,
  type ZeroClickOptions,
  type ZeroClickResult,
} from './zero-click'
