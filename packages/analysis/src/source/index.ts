export { analyzeFromSource, AnalyzerCapabilityError } from './analyze-from-source'
export { createCompositeSource } from './composite'
export type { CompositeSourceOptions } from './composite'
export { createInMemoryQuerySource, IN_MEMORY_DEFAULT_CAPABILITIES } from './in-memory'
export type { InMemoryQuerySourceOptions } from './in-memory'
export {
  analyzeBrandSegmentationFromSource,
  analyzeClusteringFromSource,
  analyzeDecayFromSource,
  analyzeKeywordConcentrationFromSource,
  analyzeMoversFromSource,
  analyzeOpportunityFromSource,
  analyzePageConcentrationFromSource,
  analyzeSeasonalityFromSource,
  analyzeStrikingDistanceFromSource,
  queryAnalyticsFromSource,
  queryComparisonFromSource,
} from './portable'
export type {
  ComparisonQueryResult,
  QueryDimension,
  QueryOptions,
  QueryResult,
} from './shared-types'
