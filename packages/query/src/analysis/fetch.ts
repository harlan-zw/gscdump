/**
 * Provider-based fetch wrappers for analysis functions.
 *
 * Each function checks for provider-level optimized methods first (DB uses SQL),
 * then falls back to pure functions from gscdump (JS computation).
 */

import type { BrandSegmentationOptions, BrandSegmentationResult, CannibalizationOptions, CannibalizationResult, ConcentrationOptions, ConcentrationResult, DecayOptions, DecayResult, MoversOptions, MoversResult, OpportunityOptions, OpportunityResult, ResolvedAnalyticsRange, SeasonalityOptions, SeasonalityResult, StrikingDistanceOptions, StrikingDistanceResult, ZeroClickOptions, ZeroClickResult } from 'gscdump'
import type { DataProvider } from '../types'
import { analyzeBrandSegmentation, analyzeCannibalization, analyzeDecay, analyzeKeywordConcentration, analyzeMovers, analyzeOpportunity, analyzePageConcentration, analyzeSeasonality, analyzeStrikingDistance, analyzeZeroClick } from 'gscdump'

// Striking distance: check for optimized method, else use keyword data
export async function fetchStrikingDistanceAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: StrikingDistanceOptions,
): Promise<StrikingDistanceResult[]> {
  if (provider.getStrikingDistanceResults)
    return provider.getStrikingDistanceResults(siteUrl, range, options)

  const { current } = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeStrikingDistance(current, options)
}

// Opportunity: uses keyword data (no DB optimization - complex scoring)
export async function fetchOpportunityAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: OpportunityOptions,
): Promise<OpportunityResult[]> {
  const { current } = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeOpportunity(current, options)
}

// Brand segmentation: uses keyword data (no DB optimization yet)
export async function fetchBrandAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options: BrandSegmentationOptions,
): Promise<BrandSegmentationResult> {
  const { current } = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeBrandSegmentation(current, options)
}

// Page concentration: uses page data (no DB optimization - simple computation)
export async function fetchPageConcentrationAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: ConcentrationOptions,
): Promise<ConcentrationResult> {
  const { current } = await provider.getPagesWithComparison(siteUrl, range)
  return analyzePageConcentration(current, options)
}

// Keyword concentration: uses keyword data (no DB optimization - simple computation)
export async function fetchKeywordConcentrationAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: ConcentrationOptions,
): Promise<ConcentrationResult> {
  const { current } = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeKeywordConcentration(current, options)
}

// Decay: check for optimized method, else use page comparison data
export async function fetchDecayAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: DecayOptions,
): Promise<DecayResult[]> {
  if (provider.getDecayResults)
    return provider.getDecayResults(siteUrl, range, options)

  const comparison = await provider.getPagesWithComparison(siteUrl, range)
  return analyzeDecay({
    current: comparison.current,
    previous: comparison.previous,
  }, options)
}

// Movers: check for optimized method, else use keyword comparison data
export async function fetchMoversAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: MoversOptions,
): Promise<MoversResult> {
  if (provider.getMoversResults)
    return provider.getMoversResults(siteUrl, range, options)

  const comparison = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeMovers({
    current: comparison.current,
    previous: comparison.previous,
  }, options)
}

// Cannibalization: check for optimized method, else use query+page rows
export async function fetchCannibalizationAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: CannibalizationOptions,
): Promise<CannibalizationResult[]> {
  if (provider.getCannibalizationResults)
    return provider.getCannibalizationResults(siteUrl, range, options)

  if (!provider.getQueryPageRows)
    throw new Error('Provider does not support getQueryPageRows')
  const rows = await provider.getQueryPageRows(siteUrl, range)
  return analyzeCannibalization(rows, options)
}

// Zero-click: check for optimized method, else use query+page rows
export async function fetchZeroClickAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: ZeroClickOptions,
): Promise<ZeroClickResult[]> {
  if (provider.getZeroClickResults)
    return provider.getZeroClickResults(siteUrl, range, options)

  if (!provider.getQueryPageRows)
    throw new Error('Provider does not support getQueryPageRows')
  const rows = await provider.getQueryPageRows(siteUrl, range)
  return analyzeZeroClick(rows, options)
}

// Seasonality: check for optimized method, else use date rows
export async function fetchSeasonalityAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: SeasonalityOptions,
): Promise<SeasonalityResult> {
  if (provider.getSeasonalityResults)
    return provider.getSeasonalityResults(siteUrl, range, options)

  if (!provider.getDateRows)
    throw new Error('Provider does not support getDateRows')
  const rows = await provider.getDateRows(siteUrl, range)
  return analyzeSeasonality(rows, options)
}
