/**
 * Analysis module - pure functions and provider-based wrappers.
 *
 * Pure functions operate on typed data and return typed results.
 * Fetch functions use DataProvider to get data, then call pure functions.
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
