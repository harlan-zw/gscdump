/**
 * Row-based analyzer collection. Pure JS — portable across any
 * `AnalysisQuerySource` that yields rows (live GSC API, in-memory, SQL
 * engines via their row path).
 *
 * Export is a plain array so consumers can compose registries without
 * triggering side effects. Pass to `createAnalyzerRegistry({ rows: ROW_ANALYZERS })`.
 */

import type { Analyzer } from './types'

import { strikingDistanceAnalyzer } from '../analyzers/striking-distance'
import { analyzeBrandSegmentation } from '../brand'
import { analyzeClustering } from '../clustering'
import { analyzeKeywordConcentration, analyzePageConcentration } from '../concentration'
import { analyzeDecay } from '../decay'
import { analyzeMovers } from '../movers'
import { analyzeOpportunity } from '../opportunity'
import { comparisonOf, periodOf } from '../period'
import { analyzeSeasonality } from '../seasonality'
import {
  adaptRowAnalyzer,
  datesQueryState,
  keywordsQueryState,
  pagesQueryState,
} from './adapt-rows'

export const ROW_ANALYZERS: readonly Analyzer[] = [
  strikingDistanceAnalyzer.rows!,
  adaptRowAnalyzer<unknown>({
    id: 'opportunity',
    buildQueries: params => ({ keywords: keywordsQueryState(periodOf(params), params.limit) }),
    reduce: ({ keywords }, params) => {
      const results = analyzeOpportunity(keywords as any, {
        minImpressions: params.minImpressions,
      })
      return { results, meta: { total: results.length } }
    },
  }),
  adaptRowAnalyzer<unknown>({
    id: 'brand',
    buildQueries: params => ({ keywords: keywordsQueryState(periodOf(params), params.limit) }),
    reduce: ({ keywords }, params) => {
      if (!params.brandTerms?.length)
        throw new Error('Brand analysis requires brandTerms')
      const result = analyzeBrandSegmentation(keywords as any, {
        brandTerms: params.brandTerms,
        minImpressions: params.minImpressions,
      })
      return {
        results: [
          ...result.brand.map(r => ({ ...r, segment: 'brand' as const })),
          ...result.nonBrand.map(r => ({ ...r, segment: 'non-brand' as const })),
        ],
        meta: { summary: result.summary },
      }
    },
  }),
  adaptRowAnalyzer<unknown>({
    id: 'concentration',
    buildQueries: (params) => {
      const dim = params.dimension || 'pages'
      const out: Record<string, any> = {}
      if (dim === 'pages')
        out.pages = pagesQueryState(periodOf(params), params.limit)
      else
        out.keywords = keywordsQueryState(periodOf(params), params.limit)
      return out
    },
    reduce: (rows, params) => {
      const dim = params.dimension || 'pages'
      const result = dim === 'pages'
        ? analyzePageConcentration(rows.pages as any, { topN: params.topN })
        : analyzeKeywordConcentration(rows.keywords as any, { topN: params.topN })
      return { results: [result], meta: { dimension: dim } }
    },
  }),
  adaptRowAnalyzer<unknown>({
    id: 'clustering',
    buildQueries: params => ({ keywords: keywordsQueryState(periodOf(params), params.limit) }),
    reduce: ({ keywords }, params) => {
      const result = analyzeClustering(keywords as any, {
        clusterBy: params.clusterBy,
        minClusterSize: params.minClusterSize,
        minImpressions: params.minImpressions,
      })
      return { results: result.clusters, meta: { totalClusters: result.clusters.length } }
    },
  }),
  adaptRowAnalyzer<unknown>({
    id: 'seasonality',
    buildQueries: params => ({ dates: datesQueryState(periodOf(params), params.limit) }),
    reduce: ({ dates }, params) => {
      const result = analyzeSeasonality(dates as any, { metric: params.metric })
      return { results: result.monthlyBreakdown, meta: { strength: result.strength } }
    },
  }),
  adaptRowAnalyzer<unknown>({
    id: 'movers',
    buildQueries: (params) => {
      const cmp = comparisonOf(params)
      return {
        current: keywordsQueryState(cmp.current, params.limit),
        previous: keywordsQueryState(cmp.previous, params.limit),
      }
    },
    reduce: ({ current, previous }, params) => {
      const result = analyzeMovers({ current: current as any, previous: previous as any }, {
        changeThreshold: params.changeThreshold,
        minImpressions: params.minImpressions,
      })
      return {
        results: [
          ...result.rising.map(r => ({ ...r, direction: 'rising' as const })),
          ...result.declining.map(r => ({ ...r, direction: 'declining' as const })),
        ],
        meta: { rising: result.rising.length, declining: result.declining.length },
      }
    },
  }),
  adaptRowAnalyzer<unknown>({
    id: 'decay',
    buildQueries: (params) => {
      const cmp = comparisonOf(params)
      return {
        current: pagesQueryState(cmp.current, params.limit),
        previous: pagesQueryState(cmp.previous, params.limit),
      }
    },
    reduce: ({ current, previous }, params) => {
      const results = analyzeDecay({ current: current as any, previous: previous as any }, {
        minPreviousClicks: params.minPreviousClicks,
        threshold: params.threshold,
      })
      return { results, meta: { total: results.length } }
    },
  }),
]
