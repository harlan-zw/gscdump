import type {
  CannibalizationResult,
  DecayResult,
  MoversAndShakersResult,
  StrikingDistanceResult,
  YoYComparisonResult,
  ZeroClickResult,
} from 'gscdump'
import type { z } from 'zod'
import type { cannibalizationInput, contentDecayInput, HandlerContext, moversAndShakersInput, strikingDistanceInput, yoyComparisonInput, zeroClickInput } from '../types'
import {
  analyzeMoversAndShakers as gscAnalyzeMovers,
  analyzeCannibalization as gscAnalyzeCannibalization,
  analyzeContentDecay as gscAnalyzeContentDecay,
  fetchYoYComparison as gscFetchYoY,
  analyzeStrikingDistance as gscAnalyzeStrikingDistance,
  analyzeZeroClickQueries as gscAnalyzeZeroClickQueries,
} from '@gscdump/query'
import { toPeriod } from '../types'

export async function detectCannibalization(
  input: z.infer<typeof cannibalizationInput>,
  ctx: HandlerContext,
): Promise<CannibalizationResult[]> {
  return gscAnalyzeCannibalization(ctx.client, input.siteUrl, {
    period: input.period ? toPeriod(input.period) : undefined,
    minImpressions: input.minImpressions,
    maxPositionSpread: input.maxPositionSpread,
    minPages: input.minPages,
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
  })
}

export async function findStrikingDistance(
  input: z.infer<typeof strikingDistanceInput>,
  ctx: HandlerContext,
): Promise<StrikingDistanceResult[]> {
  return gscAnalyzeStrikingDistance(ctx.client, input.siteUrl, {
    period: input.period ? toPeriod(input.period) : undefined,
    minPosition: input.minPosition,
    maxPosition: input.maxPosition,
    minImpressions: input.minImpressions,
    maxCtr: input.maxCtr,
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
  })
}

export async function fetchYoYComparison(
  input: z.infer<typeof yoyComparisonInput>,
  ctx: HandlerContext,
): Promise<YoYComparisonResult> {
  return gscFetchYoY(ctx.client, input.siteUrl, {
    period: input.period ? toPeriod(input.period) : undefined,
  })
}

export async function analyzeMoversAndShakers(
  input: z.infer<typeof moversAndShakersInput>,
  ctx: HandlerContext,
): Promise<MoversAndShakersResult> {
  return gscAnalyzeMovers(ctx.client, input.siteUrl, {
    period: input.period ? toPeriod(input.period) : undefined,
    comparePeriod: input.comparePeriod ? toPeriod(input.comparePeriod) : undefined,
    changeThreshold: input.changeThreshold,
    minImpressions: input.minImpressions,
    sortBy: input.sortBy,
  })
}

export async function detectContentDecay(
  input: z.infer<typeof contentDecayInput>,
  ctx: HandlerContext,
): Promise<DecayResult[]> {
  return gscAnalyzeContentDecay(ctx.client, input.siteUrl, {
    period: input.period ? toPeriod(input.period) : undefined,
    lookbackDays: input.lookbackDays,
    minPreviousClicks: input.minPreviousClicks,
    threshold: input.threshold,
    sortBy: input.sortBy,
  })
}

export async function findZeroClickQueries(
  input: z.infer<typeof zeroClickInput>,
  ctx: HandlerContext,
): Promise<ZeroClickResult[]> {
  return gscAnalyzeZeroClickQueries(ctx.client, input.siteUrl, {
    period: input.period ? toPeriod(input.period) : undefined,
    minImpressions: input.minImpressions,
    maxCtr: input.maxCtr,
    maxPosition: input.maxPosition,
  })
}
