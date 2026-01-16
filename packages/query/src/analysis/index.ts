/**
 * Analysis module - re-exports pure functions from gscdump
 * and provides provider-based fetch wrappers.
 */

// Types (local QueryPageRow, DateMetrics for provider interface)
export * from './types'

// Re-export all pure analysis functions and types from gscdump
export {
  // Functions
  analyzeStrikingDistance,
  analyzeOpportunity,
  analyzeBrandSegmentation,
  analyzeConcentration,
  analyzePageConcentration,
  analyzeKeywordConcentration,
  analyzeDecay,
  analyzeMovers,
  analyzeCannibalization,
  analyzeZeroClick,
  analyzeSeasonality,
  analyzeClustering,
  // Types - Striking Distance
  type StrikingDistanceOptions,
  type StrikingDistanceResult,
  type StrikingDistanceSortMetric,
  // Types - Opportunity
  type OpportunityOptions,
  type OpportunityResult,
  type OpportunitySortMetric,
  type OpportunityWeights,
  type OpportunityFactors,
  // Types - Brand
  type BrandSegmentationOptions,
  type BrandSegmentationResult,
  type BrandSummary,
  // Types - Concentration
  type ConcentrationOptions,
  type ConcentrationResult,
  type ConcentrationItem,
  type ConcentrationInput,
  type ConcentrationRiskLevel,
  // Types - Decay
  type DecayOptions,
  type DecayResult,
  type DecayInput,
  type DecaySortMetric,
  // Types - Movers
  type MoversOptions,
  type MoversResult,
  type MoversInput,
  type MoverData,
  type MoversSortMetric,
  // Types - Cannibalization
  type CannibalizationOptions,
  type CannibalizationResult,
  type CannibalizationPage,
  type CannibalizationSortMetric,
  // Types - Zero Click
  type ZeroClickOptions,
  type ZeroClickResult,
  // Types - Seasonality
  type SeasonalityOptions,
  type SeasonalityResult,
  type SeasonalityMetric,
  type MonthlyData,
  // Types - Clustering
  type ClusteringOptions,
  type ClusteringResult,
  type KeywordCluster,
  type ClusterType,
} from 'gscdump'

// Provider-based fetch wrappers
export {
  fetchBrandAnalysis,
  fetchCannibalizationAnalysis,
  fetchDecayAnalysis,
  fetchKeywordConcentrationAnalysis,
  fetchMoversAnalysis,
  fetchOpportunityAnalysis,
  fetchPageConcentrationAnalysis,
  fetchSeasonalityAnalysis,
  fetchStrikingDistanceAnalysis,
  fetchZeroClickAnalysis,
} from './fetch'
