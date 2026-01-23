/**
 * Fetch + analyze wrappers that use the query builder for real API calls.
 */

import type { GoogleSearchConsoleClient } from '../core/client'
import type { BrandSegmentationOptions, BrandSegmentationResult } from './brand'
import type { ClusteringOptions, ClusteringResult } from './clustering'
import type { ConcentrationOptions, ConcentrationResult } from './concentration'
import type { DecayOptions, DecayResult } from './decay'
import type { MoversOptions, MoversResult } from './movers'
import type { OpportunityOptions, OpportunityResult } from './opportunity'
import type { SeasonalityOptions, SeasonalityResult } from './seasonality'
import type { StrikingDistanceOptions, StrikingDistanceResult } from './striking-distance'
import type { DateRow, KeywordRow, PageRow } from './types'
import { between, date, gsc, page, query } from '../query'
import { analyzeBrandSegmentation } from './brand'
import { analyzeClustering } from './clustering'
import { analyzeKeywordConcentration, analyzePageConcentration } from './concentration'
import { analyzeDecay } from './decay'
import { analyzeMovers } from './movers'
import { analyzeOpportunity } from './opportunity'
import { analyzeSeasonality } from './seasonality'
import { analyzeStrikingDistance } from './striking-distance'

export interface AnalysisPeriod {
  startDate: string
  endDate: string
}

export interface ComparisonPeriod {
  current: AnalysisPeriod
  previous: AnalysisPeriod
}

export type QueryDimension = 'keywords' | 'pages' | 'dates'

export interface QueryOptions {
  /** Dimension to query. Default: keywords */
  dimension?: QueryDimension
  /** Max rows to fetch. Default: 25000 */
  limit?: number
}

export interface QueryResult {
  keywords: KeywordRow[]
  pages: PageRow[]
  dates: DateRow[]
}

export interface ComparisonQueryResult {
  current: QueryResult
  previous: QueryResult
}

/** Collect all rows from async generator */
async function collectRows<T>(generator: AsyncGenerator<T[]>): Promise<T[]> {
  const rows: T[] = []
  for await (const batch of generator) {
    rows.push(...batch)
  }
  return rows
}

/** Fetch keywords (query+page dimensions) for a period */
async function fetchKeywordsInternal(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  limit = 25000,
): Promise<KeywordRow[]> {
  const builder = gsc
    .select(query, page)
    .where(between(date, period.startDate, period.endDate))
    .limit(limit)

  return collectRows(client.query(siteUrl, builder)) as Promise<KeywordRow[]>
}

/** Fetch pages (page dimension) for a period */
async function fetchPagesInternal(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  limit = 25000,
): Promise<PageRow[]> {
  const builder = gsc
    .select(page)
    .where(between(date, period.startDate, period.endDate))
    .limit(limit)

  return collectRows(client.query(siteUrl, builder)) as Promise<PageRow[]>
}

/** Fetch dates (date dimension) for a period */
async function fetchDatesInternal(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  limit = 25000,
): Promise<DateRow[]> {
  const builder = gsc
    .select(date)
    .where(between(date, period.startDate, period.endDate))
    .limit(limit)

  return collectRows(client.query(siteUrl, builder)) as Promise<DateRow[]>
}

// --- Generic Query Functions ---

/**
 * Query search analytics data for a single period.
 * Returns keywords, pages, and dates data.
 * API calls: 3 (one per dimension)
 */
export async function queryAnalytics(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const limit = options.limit ?? 25000

  const [keywords, pages, dates] = await Promise.all([
    fetchKeywordsInternal(client, siteUrl, period, limit),
    fetchPagesInternal(client, siteUrl, period, limit),
    fetchDatesInternal(client, siteUrl, period, limit),
  ])

  return { keywords, pages, dates }
}

/**
 * Query search analytics data for current and previous periods.
 * Returns comparison data for all dimensions.
 * API calls: 6 (3 per period)
 */
export async function queryComparison(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  periods: ComparisonPeriod,
  options: QueryOptions = {},
): Promise<ComparisonQueryResult> {
  const [current, previous] = await Promise.all([
    queryAnalytics(client, siteUrl, periods.current, options),
    queryAnalytics(client, siteUrl, periods.previous, options),
  ])

  return { current, previous }
}

// Aliases for internal functions (exported for direct use)
const fetchKeywords = fetchKeywordsInternal
const fetchPages = fetchPagesInternal
const fetchDates = fetchDatesInternal

// --- Single Period Analyses (1-2 API calls) ---

/**
 * Fetch keywords and analyze striking distance opportunities.
 * API calls: 1
 */
export async function fetchStrikingDistance(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  options?: StrikingDistanceOptions,
): Promise<StrikingDistanceResult[]> {
  const keywords = await fetchKeywords(client, siteUrl, period)
  return analyzeStrikingDistance(keywords, options)
}

/**
 * Fetch keywords and analyze optimization opportunities.
 * API calls: 1
 */
export async function fetchOpportunity(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  options?: OpportunityOptions,
): Promise<OpportunityResult[]> {
  const keywords = await fetchKeywords(client, siteUrl, period)
  return analyzeOpportunity(keywords, options)
}

/**
 * Fetch keywords and analyze brand vs non-brand segmentation.
 * API calls: 1
 */
export async function fetchBrandSegmentation(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  options: BrandSegmentationOptions,
): Promise<BrandSegmentationResult> {
  const keywords = await fetchKeywords(client, siteUrl, period)
  return analyzeBrandSegmentation(keywords, options)
}

/**
 * Fetch pages and analyze traffic concentration.
 * API calls: 1
 */
export async function fetchPageConcentration(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  options?: ConcentrationOptions,
): Promise<ConcentrationResult> {
  const pages = await fetchPages(client, siteUrl, period)
  return analyzePageConcentration(pages, options)
}

/**
 * Fetch keywords and analyze traffic concentration.
 * API calls: 1
 */
export async function fetchKeywordConcentration(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  options?: ConcentrationOptions,
): Promise<ConcentrationResult> {
  const keywords = await fetchKeywords(client, siteUrl, period)
  return analyzeKeywordConcentration(keywords, options)
}

/**
 * Fetch keywords and analyze clusters.
 * API calls: 1
 */
export async function fetchClustering(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  options?: ClusteringOptions,
): Promise<ClusteringResult> {
  const keywords = await fetchKeywords(client, siteUrl, period)
  return analyzeClustering(keywords, options)
}

/**
 * Fetch dates and analyze seasonality patterns.
 * API calls: 1
 */
export async function fetchSeasonality(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  period: AnalysisPeriod,
  options?: SeasonalityOptions,
): Promise<SeasonalityResult> {
  const dates = await fetchDates(client, siteUrl, period)
  return analyzeSeasonality(dates, options)
}

// --- Comparison Analyses (2 API calls) ---

/**
 * Fetch pages for both periods and analyze content decay.
 * API calls: 2
 */
export async function fetchDecay(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  periods: ComparisonPeriod,
  options?: DecayOptions,
): Promise<DecayResult[]> {
  const [current, previous] = await Promise.all([
    fetchPages(client, siteUrl, periods.current),
    fetchPages(client, siteUrl, periods.previous),
  ])
  return analyzeDecay({ current, previous }, options)
}

/**
 * Fetch keywords for both periods and analyze movers/shakers.
 * API calls: 2
 */
export async function fetchMovers(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  periods: ComparisonPeriod,
  options?: MoversOptions,
): Promise<MoversResult> {
  const [current, previous] = await Promise.all([
    fetchKeywords(client, siteUrl, periods.current),
    fetchKeywords(client, siteUrl, periods.previous),
  ])
  return analyzeMovers({ current, previous }, options)
}
