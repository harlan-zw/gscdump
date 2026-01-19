/**
 * Analysis module - re-exports pure functions from gscdump
 * and provides provider-based fetch wrappers.
 */

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

// Types (local QueryPageRow, DateMetrics for provider interface)
export * from './types'

// Re-export all pure analysis functions and types from gscdump
export {
  analyzeBrandSegmentation,
  analyzeCannibalization,
  analyzeClustering,
  analyzeConcentration,
  analyzeDecay,
  analyzeKeywordConcentration,
  analyzeMovers,
  analyzeOpportunity,
  analyzePageConcentration,
  analyzeSeasonality,
  // Functions
  analyzeStrikingDistance,
  analyzeZeroClick,
  // Types - Brand
  type BrandSegmentationOptions,
  type BrandSegmentationResult,
  type BrandSummary,
  // Types - Cannibalization
  type CannibalizationOptions,
  type CannibalizationPage,
  type CannibalizationResult,
  type CannibalizationSortMetric,
  // Types - Clustering
  type ClusteringOptions,
  type ClusteringResult,
  type ClusterType,
  type ConcentrationInput,
  type ConcentrationItem,
  // Types - Concentration
  type ConcentrationOptions,
  type ConcentrationResult,
  type ConcentrationRiskLevel,
  type DecayInput,
  // Types - Decay
  type DecayOptions,
  type DecayResult,
  type DecaySortMetric,
  type KeywordCluster,
  type MonthlyData,
  type MoverData,
  type MoversInput,
  // Types - Movers
  type MoversOptions,
  type MoversResult,
  type MoversSortMetric,
  type OpportunityFactors,
  // Types - Opportunity
  type OpportunityOptions,
  type OpportunityResult,
  type OpportunitySortMetric,
  type OpportunityWeights,
  type SeasonalityMetric,
  // Types - Seasonality
  type SeasonalityOptions,
  type SeasonalityResult,
  // Types - Striking Distance
  type StrikingDistanceOptions,
  type StrikingDistanceResult,
  type StrikingDistanceSortMetric,
  // Types - Zero Click
  type ZeroClickOptions,
  type ZeroClickResult,
} from 'gscdump'
