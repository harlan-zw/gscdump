import {
  ARCHETYPE_EXECUTION_CLASS as CONTRACT_ARCHETYPE_EXECUTION_CLASS,
  arbitrarySql as createArbitrarySql,
  auxCloudOnly as createAuxCloudOnly,
  entityDailySparkline as createEntityDailySparkline,
  entityDailyTimeseries as createEntityDailyTimeseries,
  multiSeriesStackedDaily as createMultiSeriesStackedDaily,
  singleRowLookup as createSingleRowLookup,
  siteDailyTimeseries as createSiteDailyTimeseries,
  topNBreakdown as createTopNBreakdown,
  twoDimensionDetail as createTwoDimensionDetail,
} from '@gscdump/contracts/archetypes'

export type * from '@gscdump/contracts/archetypes'

// Local value aliases keep generated SDK declarations value-correct while the
// canonical implementations remain owned by @gscdump/contracts/archetypes.
export const ARCHETYPE_EXECUTION_CLASS = CONTRACT_ARCHETYPE_EXECUTION_CLASS
export const arbitrarySql = createArbitrarySql
export const auxCloudOnly = createAuxCloudOnly
export const entityDailySparkline = createEntityDailySparkline
export const entityDailyTimeseries = createEntityDailyTimeseries
export const multiSeriesStackedDaily = createMultiSeriesStackedDaily
export const singleRowLookup = createSingleRowLookup
export const siteDailyTimeseries = createSiteDailyTimeseries
export const topNBreakdown = createTopNBreakdown
export const twoDimensionDetail = createTwoDimensionDetail
