/**
 * Provider-based fetch wrappers for analysis functions.
 * These fetch data via DataProvider and pass to pure analysis functions.
 */

import type { ResolvedAnalyticsRange } from 'gscdump'
import type { DataProvider } from '../types'

import {
  analyzeStrikingDistance,
  type StrikingDistanceOptions,
  type StrikingDistanceResult,
} from './striking-distance'

import {
  analyzeOpportunity,
  type OpportunityOptions,
  type OpportunityResult,
} from './opportunity'

import {
  analyzeBrandSegmentation,
  type BrandSegmentationOptions,
  type BrandSegmentationResult,
} from './brand'

import {
  analyzePageConcentration,
  analyzeKeywordConcentration,
  type ConcentrationOptions,
  type ConcentrationResult,
} from './concentration'

import {
  analyzeDecay,
  type DecayOptions,
  type DecayResult,
} from './decay'

import {
  analyzeMovers,
  type MoversOptions,
  type MoversResult,
} from './movers'

import {
  analyzeCannibalization,
  type CannibalizationOptions,
  type CannibalizationResult,
} from './cannibalization'

import {
  analyzeZeroClick,
  type ZeroClickOptions,
  type ZeroClickResult,
} from './zero-click'

import {
  analyzeSeasonality,
  type SeasonalityOptions,
  type SeasonalityResult,
} from './seasonality'

// Striking distance: uses keyword data
export async function fetchStrikingDistanceAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: StrikingDistanceOptions,
): Promise<StrikingDistanceResult[]> {
  const { current } = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeStrikingDistance(current, options)
}

// Opportunity: uses keyword data
export async function fetchOpportunityAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: OpportunityOptions,
): Promise<OpportunityResult[]> {
  const { current } = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeOpportunity(current, options)
}

// Brand segmentation: uses keyword data
export async function fetchBrandAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options: BrandSegmentationOptions,
): Promise<BrandSegmentationResult> {
  const { current } = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeBrandSegmentation(current, options)
}

// Page concentration: uses page data
export async function fetchPageConcentrationAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: ConcentrationOptions,
): Promise<ConcentrationResult> {
  const { current } = await provider.getPagesWithComparison(siteUrl, range)
  return analyzePageConcentration(current, options)
}

// Keyword concentration: uses keyword data
export async function fetchKeywordConcentrationAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: ConcentrationOptions,
): Promise<ConcentrationResult> {
  const { current } = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeKeywordConcentration(current, options)
}

// Decay: uses page comparison data
export async function fetchDecayAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: DecayOptions,
): Promise<DecayResult[]> {
  const comparison = await provider.getPagesWithComparison(siteUrl, range)
  return analyzeDecay({
    current: comparison.current,
    previous: comparison.previous,
  }, options)
}

// Movers: uses keyword comparison data
export async function fetchMoversAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: MoversOptions,
): Promise<MoversResult> {
  const comparison = await provider.getKeywordsWithComparison(siteUrl, range)
  return analyzeMovers({
    current: comparison.current,
    previous: comparison.previous,
  }, options)
}

// Cannibalization: uses query+page rows
export async function fetchCannibalizationAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: CannibalizationOptions,
): Promise<CannibalizationResult[]> {
  if (!provider.getQueryPageRows)
    throw new Error('Provider does not support getQueryPageRows')
  const rows = await provider.getQueryPageRows(siteUrl, range)
  return analyzeCannibalization(rows, options)
}

// Zero-click: uses query+page rows
export async function fetchZeroClickAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: ZeroClickOptions,
): Promise<ZeroClickResult[]> {
  if (!provider.getQueryPageRows)
    throw new Error('Provider does not support getQueryPageRows')
  const rows = await provider.getQueryPageRows(siteUrl, range)
  return analyzeZeroClick(rows, options)
}

// Seasonality: uses date rows
export async function fetchSeasonalityAnalysis(
  provider: DataProvider,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: SeasonalityOptions,
): Promise<SeasonalityResult> {
  if (!provider.getDateRows)
    throw new Error('Provider does not support getDateRows')
  const rows = await provider.getDateRows(siteUrl, range)
  return analyzeSeasonality(rows, options)
}
