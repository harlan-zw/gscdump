import type { BrandSegmentationOptions, BrandSegmentationResult } from '../analyzers/brand'
import type { ClusteringOptions, ClusteringResult } from '../analyzers/clustering'
import type { ConcentrationOptions, ConcentrationResult } from '../analyzers/concentration'
import type { DecayOptions, DecayResult } from '../analyzers/decay'
import type { MoversOptions, MoversResult } from '../analyzers/movers'
import type { OpportunityResult } from '../analyzers/opportunity'
import type { SeasonalityOptions, SeasonalityResult } from '../analyzers/seasonality'
import type { AnalysisPeriod, ComparisonPeriod } from '@gscdump/engine/period'

import type { StrikingDistanceOptions, StrikingDistanceResult } from '../striking-distance'
import type { DateRow, KeywordRow, PageRow } from '../types'
import type {
  ComparisonQueryResult,
  QueryOptions,
  QueryResult,
} from './shared-types'

import type { AnalysisQuerySource } from '@gscdump/engine/resolver'
import type { TypedQuery } from '@gscdump/engine/source'
import { datesQueryState, keywordsQueryState, pagesQueryState } from '../analyzer/adapt-rows'
import { analyzeBrandSegmentation } from '../analyzers/brand'
import { analyzeClustering } from '../analyzers/clustering'
import { analyzeKeywordConcentration, analyzePageConcentration } from '../analyzers/concentration'
import { analyzeDecay } from '../analyzers/decay'
import { analyzeMovers } from '../analyzers/movers'
import { opportunityAnalyzer } from '../analyzers/opportunity'
import { analyzeSeasonality } from '../analyzers/seasonality'
import { analyzeStrikingDistance } from '../striking-distance'
import { queryRows, typedQuery } from '@gscdump/engine/source'

interface OpportunityOptions {
  minImpressions?: number
}

function keywordQuery(period: AnalysisPeriod, limit: number): TypedQuery<KeywordRow> {
  return typedQuery<KeywordRow>(keywordsQueryState(period, limit))
}

function pageQuery(period: AnalysisPeriod, limit: number): TypedQuery<PageRow> {
  return typedQuery<PageRow>(pagesQueryState(period, limit))
}

function dateQuery(period: AnalysisPeriod, limit: number): TypedQuery<DateRow> {
  return typedQuery<DateRow>(datesQueryState(period, limit))
}

type PortableQueryMap = Record<string, TypedQuery<unknown>>
type PortableRows<TQueries extends PortableQueryMap> = {
  [K in keyof TQueries]: TQueries[K] extends TypedQuery<infer TRow> ? TRow[] : never
}

interface PortableAnalyzerDefinition<TInput, TOptions, TResult, TQueries extends PortableQueryMap> {
  requiredQueries: (input: TInput, limit: number) => TQueries
  run: (rows: PortableRows<TQueries>, options: TOptions | undefined) => TResult
}

function definePortableAnalyzer<TInput, TOptions, TResult, TQueries extends PortableQueryMap>(
  definition: PortableAnalyzerDefinition<TInput, TOptions, TResult, TQueries>,
): PortableAnalyzerDefinition<TInput, TOptions, TResult, TQueries> {
  return definition
}

async function runPortableAnalyzer<TInput, TOptions, TResult, TQueries extends PortableQueryMap>(
  source: AnalysisQuerySource,
  definition: PortableAnalyzerDefinition<TInput, TOptions, TResult, TQueries>,
  input: TInput,
  options: TOptions | undefined,
  limit = 25000,
): Promise<TResult> {
  const requiredQueries = definition.requiredQueries(input, limit)
  const entries = Object.entries(requiredQueries) as Array<[keyof TQueries, TypedQuery<unknown>]>
  const resolvedRows = await Promise.all(
    entries.map(async ([key, spec]) => [key, await queryRows(source, spec)] as const),
  )

  return definition.run(
    Object.fromEntries(resolvedRows) as PortableRows<TQueries>,
    options,
  )
}

const PORTABLE_ANALYZERS = {
  strikingDistance: definePortableAnalyzer({
    requiredQueries: (period: AnalysisPeriod, limit: number) => ({
      keywords: keywordQuery(period, limit),
    }),
    run: ({ keywords }, options?: StrikingDistanceOptions) =>
      analyzeStrikingDistance(keywords, options),
  }),
  opportunity: definePortableAnalyzer({
    requiredQueries: (period: AnalysisPeriod, limit: number) => ({
      keywords: keywordQuery(period, limit),
    }),
    run: ({ keywords }, options?: OpportunityOptions) => {
      const { results } = opportunityAnalyzer.rows!.reduce(keywords as any, {
        params: { type: 'opportunity', minImpressions: options?.minImpressions } as any,
      })
      return results as unknown as OpportunityResult[]
    },
  }),
  brandSegmentation: definePortableAnalyzer({
    requiredQueries: (period: AnalysisPeriod, limit: number) => ({
      keywords: keywordQuery(period, limit),
    }),
    run: ({ keywords }, options?: BrandSegmentationOptions) =>
      analyzeBrandSegmentation(keywords, options!),
  }),
  pageConcentration: definePortableAnalyzer({
    requiredQueries: (period: AnalysisPeriod, limit: number) => ({
      pages: pageQuery(period, limit),
    }),
    run: ({ pages }, options?: ConcentrationOptions) =>
      analyzePageConcentration(pages, options),
  }),
  keywordConcentration: definePortableAnalyzer({
    requiredQueries: (period: AnalysisPeriod, limit: number) => ({
      keywords: keywordQuery(period, limit),
    }),
    run: ({ keywords }, options?: ConcentrationOptions) =>
      analyzeKeywordConcentration(keywords, options),
  }),
  clustering: definePortableAnalyzer({
    requiredQueries: (period: AnalysisPeriod, limit: number) => ({
      keywords: keywordQuery(period, limit),
    }),
    run: ({ keywords }, options?: ClusteringOptions) =>
      analyzeClustering(keywords, options),
  }),
  seasonality: definePortableAnalyzer({
    requiredQueries: (period: AnalysisPeriod, limit: number) => ({
      dates: dateQuery(period, limit),
    }),
    run: ({ dates }, options?: SeasonalityOptions) =>
      analyzeSeasonality(dates, options),
  }),
  decay: definePortableAnalyzer({
    requiredQueries: (periods: ComparisonPeriod, limit: number) => ({
      current: pageQuery(periods.current, limit),
      previous: pageQuery(periods.previous, limit),
    }),
    run: ({ current, previous }, options?: DecayOptions) =>
      analyzeDecay({ current, previous }, options),
  }),
  movers: definePortableAnalyzer({
    requiredQueries: (periods: ComparisonPeriod, limit: number) => ({
      current: keywordQuery(periods.current, limit),
      previous: keywordQuery(periods.previous, limit),
    }),
    run: ({ current, previous }, options?: MoversOptions) =>
      analyzeMovers({ current, previous }, options),
  }),
}

export async function queryAnalyticsFromSource(
  source: AnalysisQuerySource,
  period: AnalysisPeriod,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const limit = options.limit ?? 25000
  const [keywords, pages, dates] = await Promise.all([
    queryRows(source, keywordQuery(period, limit)),
    queryRows(source, pageQuery(period, limit)),
    queryRows(source, dateQuery(period, limit)),
  ])

  return { keywords, pages, dates }
}

export async function queryComparisonFromSource(
  source: AnalysisQuerySource,
  periods: ComparisonPeriod,
  options: QueryOptions = {},
): Promise<ComparisonQueryResult> {
  const [current, previous] = await Promise.all([
    queryAnalyticsFromSource(source, periods.current, options),
    queryAnalyticsFromSource(source, periods.previous, options),
  ])

  return { current, previous }
}

export async function analyzeStrikingDistanceFromSource(
  source: AnalysisQuerySource,
  period: AnalysisPeriod,
  options?: StrikingDistanceOptions,
): Promise<StrikingDistanceResult[]> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.strikingDistance, period, options)
}

export async function analyzeOpportunityFromSource(
  source: AnalysisQuerySource,
  period: AnalysisPeriod,
  options?: OpportunityOptions,
): Promise<OpportunityResult[]> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.opportunity, period, options)
}

export async function analyzeBrandSegmentationFromSource(
  source: AnalysisQuerySource,
  period: AnalysisPeriod,
  options: BrandSegmentationOptions,
): Promise<BrandSegmentationResult> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.brandSegmentation, period, options)
}

export async function analyzePageConcentrationFromSource(
  source: AnalysisQuerySource,
  period: AnalysisPeriod,
  options?: ConcentrationOptions,
): Promise<ConcentrationResult> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.pageConcentration, period, options)
}

export async function analyzeKeywordConcentrationFromSource(
  source: AnalysisQuerySource,
  period: AnalysisPeriod,
  options?: ConcentrationOptions,
): Promise<ConcentrationResult> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.keywordConcentration, period, options)
}

export async function analyzeClusteringFromSource(
  source: AnalysisQuerySource,
  period: AnalysisPeriod,
  options?: ClusteringOptions,
): Promise<ClusteringResult> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.clustering, period, options)
}

export async function analyzeSeasonalityFromSource(
  source: AnalysisQuerySource,
  period: AnalysisPeriod,
  options?: SeasonalityOptions,
): Promise<SeasonalityResult> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.seasonality, period, options)
}

export async function analyzeDecayFromSource(
  source: AnalysisQuerySource,
  periods: ComparisonPeriod,
  options?: DecayOptions,
): Promise<DecayResult[]> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.decay, periods, options)
}

export async function analyzeMoversFromSource(
  source: AnalysisQuerySource,
  periods: ComparisonPeriod,
  options?: MoversOptions,
): Promise<MoversResult> {
  return runPortableAnalyzer(source, PORTABLE_ANALYZERS.movers, periods, options)
}
