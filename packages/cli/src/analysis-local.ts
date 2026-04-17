import type { AnalysisParams, AnalysisPeriod, AnalysisResult, ComparisonPeriod } from '@gscdump/analysis'
import type { googleSearchConsole } from 'gscdump'
import type { AnalyticsHarness } from './analytics'
import {
  fetchBrandSegmentation,
  fetchClustering,
  fetchDecay,
  fetchKeywordConcentration,
  fetchMovers,
  fetchOpportunity,
  fetchPageConcentration,
  fetchSeasonality,
  fetchStrikingDistance,
} from '@gscdump/analysis'
import { AnalyzerUnsupportedError, analyzeWithDuckDB } from '@gscdump/analysis/duckdb'

export class LocalStoreUnsupportedError extends Error {
  constructor(tool: string) {
    super(`analysis "${tool}" is not yet implemented against the local Parquet store`)
    this.name = 'LocalStoreUnsupportedError'
  }
}

export class LocalStoreEmptyError extends Error {
  constructor(siteUrl: string) {
    super(`no local data synced for ${siteUrl} (run \`gscdump sync\` first)`)
    this.name = 'LocalStoreEmptyError'
  }
}

export async function hasLocalData(
  harness: AnalyticsHarness,
  siteUrl: string,
): Promise<boolean> {
  const entries = await harness.engine.listLive({
    userId: harness.userId,
    siteId: harness.siteIdFor(siteUrl),
  })
  return entries.length > 0
}

export async function runLocalAnalysis(
  harness: AnalyticsHarness,
  siteUrl: string,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  return analyzeWithDuckDB(
    { engine: harness.engine },
    { userId: harness.userId, siteId: harness.siteIdFor(siteUrl) },
    params,
  ).catch((e: Error) => {
    if (e instanceof AnalyzerUnsupportedError)
      throw new LocalStoreUnsupportedError(params.type)
    throw e
  })
}

function defaultEndDate(): string {
  return new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]
}

function defaultStartDate(): string {
  return new Date(Date.now() - 31 * 86400000).toISOString().split('T')[0]
}

export async function runLiveAnalysis(
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const period: AnalysisPeriod = {
    startDate: params.startDate || defaultStartDate(),
    endDate: params.endDate || defaultEndDate(),
  }

  const comparisonPeriod: ComparisonPeriod | undefined = params.prevStartDate && params.prevEndDate
    ? { current: period, previous: { startDate: params.prevStartDate, endDate: params.prevEndDate } }
    : undefined

  switch (params.type) {
    case 'striking-distance': {
      const results = await fetchStrikingDistance(client, siteUrl, period, {
        minPosition: params.minPosition,
        maxPosition: params.maxPosition,
        minImpressions: params.minImpressions,
        maxCtr: params.maxCtr,
      })
      return { results: results as any, meta: { tool: params.type, total: results.length } }
    }
    case 'opportunity': {
      const results = await fetchOpportunity(client, siteUrl, period, {
        minImpressions: params.minImpressions,
      })
      return { results: results as any, meta: { tool: params.type, total: results.length } }
    }
    case 'movers': {
      if (!comparisonPeriod)
        throw new Error('Movers analysis requires prevStartDate and prevEndDate')
      const results = await fetchMovers(client, siteUrl, comparisonPeriod, {
        changeThreshold: params.changeThreshold,
        minImpressions: params.minImpressions,
      })
      return {
        results: [
          ...results.rising.map(r => ({ ...r, direction: 'rising' })),
          ...results.declining.map(r => ({ ...r, direction: 'declining' })),
        ] as any,
        meta: { tool: params.type, rising: results.rising.length, declining: results.declining.length },
      }
    }
    case 'decay': {
      if (!comparisonPeriod)
        throw new Error('Decay analysis requires prevStartDate and prevEndDate')
      const results = await fetchDecay(client, siteUrl, comparisonPeriod, {
        minPreviousClicks: params.minPreviousClicks,
        threshold: params.threshold,
      })
      return { results: results as any, meta: { tool: params.type, total: results.length } }
    }
    case 'brand': {
      if (!params.brandTerms?.length)
        throw new Error('Brand analysis requires brandTerms')
      const results = await fetchBrandSegmentation(client, siteUrl, period, {
        brandTerms: params.brandTerms,
        minImpressions: params.minImpressions,
      })
      return {
        results: [
          ...results.brand.map(r => ({ ...r, segment: 'brand' })),
          ...results.nonBrand.map(r => ({ ...r, segment: 'non-brand' })),
        ] as any,
        meta: { tool: params.type, summary: results.summary },
      }
    }
    case 'clustering': {
      const results = await fetchClustering(client, siteUrl, period, {
        clusterBy: params.clusterBy,
        minClusterSize: params.minClusterSize,
        minImpressions: params.minImpressions,
      })
      return {
        results: results.clusters as any,
        meta: { tool: params.type, totalClusters: results.clusters.length },
      }
    }
    case 'concentration': {
      const dim = params.dimension || 'pages'
      const results = dim === 'pages'
        ? await fetchPageConcentration(client, siteUrl, period, { topN: params.topN })
        : await fetchKeywordConcentration(client, siteUrl, period, { topN: params.topN })
      return { results: [results as any], meta: { tool: params.type, dimension: dim } }
    }
    case 'seasonality': {
      const results = await fetchSeasonality(client, siteUrl, period, {
        metric: params.metric,
      })
      return {
        results: results.monthlyBreakdown as any,
        meta: { tool: params.type, strength: results.strength },
      }
    }
    case 'zero-click':
    case 'cannibalization':
    case 'ctr-anomaly':
    case 'position-volatility':
    case 'long-tail':
    case 'intent-atlas':
    case 'query-migration':
    case 'bayesian-ctr':
    case 'stl-decompose':
    case 'change-point':
    case 'survival':
    case 'bipartite-pagerank':
      throw new Error(`${params.type} analysis requires a local Parquet store (run \`gscdump sync\` first)`)
    case 'trends':
      throw new Error(`trends analysis requires a local Parquet store (run \`gscdump sync\` first)`)
    default:
      throw new Error(`Unknown analysis type: ${params.type}`)
  }
}
