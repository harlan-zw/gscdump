/**
 * `url-clusters` — zero-ML topic clustering over `page_queries` SERP URL
 * co-occurrence. Groups search queries that predominantly rank on the same
 * URL, and surfaces high-confidence cross-lexical synonym pairs among
 * multi-URL queries using URL-IDF weighted cosine similarity with numeric,
 * polarity, and directional guards.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { QueryPageRow } from '../types'
import { fetchBudgetOf, num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { queriesQueryState } from '../analyzer/adapt-rows'
import { paginateInMemory } from '../analyzer/paginate'
import { rowString as str } from '../analyzer/row-values'

export const DEFAULT_URL_DOMINANCE_SHARE = 0.5
export const DEFAULT_URL_COOCCURRENCE_COSINE = 0.75

export interface UrlClustersOptions {
  /** Minimum total impressions for a query across all URLs. Default: 10 */
  minImpressions?: number
  /** Minimum queries assigned to a URL to emit a cluster. Default: 2 */
  minClusterSize?: number
  /** Minimum impression share on a query's dominant URL to assign it (0..1]. Default: 0.5 */
  minDominanceShare?: number
  /** Minimum URL-IDF cosine similarity for multi-URL cross-lexical synonym pairs. Default: 0.75 */
  minCooccurrenceCosine?: number
  /** Maximum cross-lexical synonym pairs returned. Default: 50 */
  maxSynonymPairs?: number
  /** Maximum top-impression multi-URL queries evaluated for pairwise synonym detection. Default: 2000 */
  maxSynonymQueries?: number
}

export interface UrlTopicClusterMember {
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  urlShare: number
}

export interface UrlTopicCluster {
  url: string
  leadQuery: string
  keywordCount: number
  totalImpressions: number
  totalClicks: number
  ctr: number
  avgPosition: number
  meanDominanceShare: number
  keywords: UrlTopicClusterMember[]
}

export interface UrlSynonymPair {
  queryA: string
  queryB: string
  cosine: number
  sharedUrls: number
  combinedImpressions: number
  topSharedUrl: string
}

export interface UrlClustersResult {
  clusters: UrlTopicCluster[]
  synonymPairs: UrlSynonymPair[]
  totalQueries: number
  clusteredQueries: number
  splitQueries: number
  unclusteredQueries: number
}

const DIGIT_RUN_RE = /\d+/g
const TOKEN_RE = /[\p{L}\p{N}]+/gu

const STOPWORDS = new Set([
  'an',
  'as',
  'at',
  'be',
  'by',
  'do',
  'if',
  'in',
  'is',
  'it',
  'my',
  'no',
  'of',
  'on',
  'or',
  'so',
  'to',
  'up',
  'us',
  'we',
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'what',
  'how',
  'why',
  'when',
  'where',
  'who',
  'which',
  'free',
  'online',
  'best',
  'top',
  'tool',
  'tools',
])

const POLARITY_TOKENS = new Set([
  'no',
  'not',
  'non',
  'without',
  'never',
  'noindex',
  'nofollow',
  'disallow',
  'disable',
  'disabled',
  'exclude',
  'off',
  'false',
  'vs',
  'versus',
  'alternative',
])

const DIRECTIONAL_CONNECTORS = new Set(['to', 'into'])
const NON_DIRECTIONAL_BEFORE = new Set([
  'how',
  'what',
  'why',
  'when',
  'where',
  'who',
  'which',
  'guide',
  'way',
  'tip',
  'intro',
  'introduction',
  'learn',
  'tutorial',
  'step',
  'reason',
  'idea',
  'example',
  'benefit',
  'need',
])

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function clampShare(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw))
    return DEFAULT_URL_DOMINANCE_SHARE
  return Math.min(1, Math.max(0.01, raw))
}

function extractTokens(query: string): string[] {
  return query.toLowerCase().match(TOKEN_RE) ?? []
}

function extractContentTokens(tokens: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const t of tokens) {
    if (t.length >= 2 && !STOPWORDS.has(t))
      out.add(t)
  }
  return out
}

function extractDigitSignature(query: string): string {
  const matches = query.match(DIGIT_RUN_RE)
  return matches ? matches.join('|') : ''
}

function extractPolaritySignature(tokens: readonly string[]): string {
  const found: string[] = []
  for (const t of tokens) {
    if (POLARITY_TOKENS.has(t))
      found.push(t)
  }
  if (found.length === 0)
    return ''
  found.sort()
  return [...new Set(found)].join('|')
}

function extractDirectionalPair(tokens: readonly string[]): [string, string] | null {
  for (let i = 1; i < tokens.length - 1; i++) {
    if (DIRECTIONAL_CONNECTORS.has(tokens[i]!) && !NON_DIRECTIONAL_BEFORE.has(tokens[i - 1]!))
      return [tokens[i - 1]!, tokens[i + 1]!]
  }
  return null
}

function hasSwappedDirection(a: readonly string[], b: readonly string[]): boolean {
  const dirA = extractDirectionalPair(a)
  const dirB = extractDirectionalPair(b)
  if (!dirA || !dirB)
    return false
  return dirA[0] === dirB[1] && dirA[1] === dirB[0] && dirA[0] !== dirA[1]
}

interface AggCell {
  clicks: number
  impressions: number
  weightedPos: number
  posSum: number
  count: number
}

interface QueryAggregate {
  query: string
  clicks: number
  impressions: number
  weightedPos: number
  posSum: number
  count: number
  urls: Map<string, AggCell>
}

/**
 * Pure helper: clusters search queries by dominant ranking URL and extracts
 * cross-lexical synonym pairs via URL-IDF cosine similarity over multi-URL
 * co-occurrence. Re-exported from `@gscdump/analysis` for portable callers.
 */
export function analyzeUrlClusters(
  rows: readonly QueryPageRow[],
  options: UrlClustersOptions = {},
): UrlClustersResult {
  const minImpressions = options.minImpressions ?? 10
  const minClusterSize = Math.max(2, Math.floor(options.minClusterSize ?? 2))
  const minDominanceShare = clampShare(options.minDominanceShare)
  const minCooccurrenceCosine = options.minCooccurrenceCosine ?? DEFAULT_URL_COOCCURRENCE_COSINE
  const maxSynonymPairs = Math.max(0, Math.floor(options.maxSynonymPairs ?? 50))
  const maxSynonymQueries = Math.max(0, Math.floor(options.maxSynonymQueries ?? 2000))

  // Step 1: Aggregate (query, url) cells and per-query totals.
  const byQuery = new Map<string, QueryAggregate>()
  for (const row of rows) {
    const query = typeof row.query === 'string' ? row.query.trim() : ''
    const url = typeof row.page === 'string' ? row.page.trim() : ''
    if (!query || !url)
      continue
    const impressions = num(row.impressions)
    const clicks = num(row.clicks)
    const position = num(row.position)

    let qAgg = byQuery.get(query)
    if (!qAgg) {
      qAgg = { query, clicks: 0, impressions: 0, weightedPos: 0, posSum: 0, count: 0, urls: new Map() }
      byQuery.set(query, qAgg)
    }
    qAgg.clicks += clicks
    qAgg.impressions += impressions
    qAgg.weightedPos += (position - 1) * impressions
    qAgg.posSum += position
    qAgg.count += 1

    let cell = qAgg.urls.get(url)
    if (!cell) {
      cell = { clicks: 0, impressions: 0, weightedPos: 0, posSum: 0, count: 0 }
      qAgg.urls.set(url, cell)
    }
    cell.clicks += clicks
    cell.impressions += impressions
    cell.weightedPos += (position - 1) * impressions
    cell.posSum += position
    cell.count += 1
  }

  // Step 2: Filter queries meeting minImpressions and count URL document frequency.
  const validQueries: QueryAggregate[] = []
  const urlDf = new Map<string, number>()
  for (const qAgg of byQuery.values()) {
    if (qAgg.impressions < minImpressions)
      continue
    validQueries.push(qAgg)
    for (const url of qAgg.urls.keys())
      urlDf.set(url, (urlDf.get(url) ?? 0) + 1)
  }

  // Step 3: Assign each query to its dominant URL when urlShare >= minDominanceShare.
  const membersByUrl = new Map<string, UrlTopicClusterMember[]>()
  let splitQueries = 0

  for (const qAgg of validQueries) {
    let bestUrl = ''
    let bestImp = -1
    let bestClicks = -1
    for (const [url, cell] of qAgg.urls) {
      if (
        cell.impressions > bestImp
        || (cell.impressions === bestImp && cell.clicks > bestClicks)
        || (cell.impressions === bestImp && cell.clicks === bestClicks && url < bestUrl)
      ) {
        bestUrl = url
        bestImp = cell.impressions
        bestClicks = cell.clicks
      }
    }
    const share = qAgg.impressions > 0 ? bestImp / qAgg.impressions : 1 / Math.max(1, qAgg.urls.size)
    if (share < minDominanceShare) {
      splitQueries++
      continue
    }
    const member: UrlTopicClusterMember = {
      query: qAgg.query,
      clicks: qAgg.clicks,
      impressions: qAgg.impressions,
      ctr: qAgg.impressions > 0 ? qAgg.clicks / qAgg.impressions : 0,
      position: qAgg.impressions > 0 ? qAgg.weightedPos / qAgg.impressions + 1 : qAgg.posSum / qAgg.count,
      urlShare: round4(share),
    }
    const list = membersByUrl.get(bestUrl)
    if (list)
      list.push(member)
    else
      membersByUrl.set(bestUrl, [member])
  }

  // Step 4: Build clusters meeting minClusterSize.
  const clusters: UrlTopicCluster[] = []
  let clusteredQueries = 0
  let unclusteredQueries = 0

  for (const [url, members] of membersByUrl) {
    if (members.length < minClusterSize) {
      unclusteredQueries += members.length
      continue
    }
    members.sort((a, b) =>
      b.impressions - a.impressions
      || b.clicks - a.clicks
      || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0),
    )
    let totalImpressions = 0
    let totalClicks = 0
    let weightedPos = 0
    let posWeight = 0
    let posSum = 0
    let shareSum = 0
    for (const m of members) {
      totalImpressions += m.impressions
      totalClicks += m.clicks
      posSum += m.position
      shareSum += m.urlShare
      if (m.impressions > 0) {
        weightedPos += (m.position - 1) * m.impressions
        posWeight += m.impressions
      }
    }
    clusteredQueries += members.length
    clusters.push({
      url,
      leadQuery: members[0]!.query,
      keywordCount: members.length,
      totalImpressions,
      totalClicks,
      ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
      avgPosition: posWeight > 0 ? weightedPos / posWeight + 1 : posSum / members.length,
      meanDominanceShare: round4(shareSum / members.length),
      keywords: members,
    })
  }

  clusters.sort((a, b) =>
    b.totalImpressions - a.totalImpressions
    || b.totalClicks - a.totalClicks
    || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  )

  // Step 5: Surface cross-lexical synonym pairs among multi-URL queries sharing >= 2 URLs.
  const synonymPairs = maxSynonymPairs > 0 && maxSynonymQueries > 0
    ? extractCrossLexicalSynonymPairs(validQueries, urlDf, {
        minCosine: minCooccurrenceCosine,
        maxPairs: maxSynonymPairs,
        maxQueries: maxSynonymQueries,
      })
    : []

  return {
    clusters,
    synonymPairs,
    totalQueries: validQueries.length,
    clusteredQueries,
    splitQueries,
    unclusteredQueries,
  }
}

interface MultiUrlEntry {
  agg: QueryAggregate
  vec: Map<string, number>
  tokens: string[]
  contentTokens: Set<string>
  numSig: string
  polaritySig: string
}

function extractCrossLexicalSynonymPairs(
  validQueries: readonly QueryAggregate[],
  urlDf: ReadonlyMap<string, number>,
  options: { minCosine: number, maxPairs: number, maxQueries: number },
): UrlSynonymPair[] {
  const totalN = validQueries.length
  if (totalN < 2)
    return []

  const multiUrl = validQueries
    .filter(q => q.urls.size >= 2 && q.impressions > 0)
    .sort((a, b) =>
      b.impressions - a.impressions
      || b.clicks - a.clicks
      || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0),
    )
    .slice(0, options.maxQueries)

  if (multiUrl.length < 2)
    return []

  // Skip overly broad hub URLs in candidate-pair generation to avoid quadratic blowup.
  const maxHubDf = Math.min(500, Math.max(50, Math.floor(totalN * 0.2)))

  const entries: MultiUrlEntry[] = []
  const invUrl = new Map<string, number[]>()

  for (const agg of multiUrl) {
    const vec = new Map<string, number>()
    let normSq = 0
    for (const [url, cell] of agg.urls) {
      if (cell.impressions <= 0)
        continue
      const df = urlDf.get(url) ?? 1
      const idf = Math.log((totalN + 1) / (df + 1)) + 1
      const weight = (cell.impressions / agg.impressions) * idf
      vec.set(url, weight)
      normSq += weight * weight
    }
    if (normSq === 0)
      continue
    const invNorm = 1 / Math.sqrt(normSq)
    for (const [url, w] of vec)
      vec.set(url, w * invNorm)

    const tokens = extractTokens(agg.query)
    const idx = entries.length
    entries.push({
      agg,
      vec,
      tokens,
      contentTokens: extractContentTokens(tokens),
      numSig: extractDigitSignature(agg.query),
      polaritySig: extractPolaritySignature(tokens),
    })

    for (const url of vec.keys()) {
      const df = urlDf.get(url) ?? 0
      if (df > maxHubDf)
        continue
      const posting = invUrl.get(url)
      if (posting)
        posting.push(idx)
      else
        invUrl.set(url, [idx])
    }
  }

  const pairs: UrlSynonymPair[] = []

  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]!
    const candidateShared = new Map<number, number>()
    for (const url of a.vec.keys()) {
      const posting = invUrl.get(url)
      if (!posting)
        continue
      for (const j of posting) {
        if (j <= i)
          continue
        candidateShared.set(j, (candidateShared.get(j) ?? 0) + 1)
      }
    }

    for (const [j, sharedNonHub] of candidateShared) {
      if (sharedNonHub < 2)
        continue
      const b = entries[j]!
      if (a.numSig !== b.numSig || a.polaritySig !== b.polaritySig)
        continue
      if (hasSwappedDirection(a.tokens, b.tokens))
        continue

      // Require non-empty content tokens with zero overlap so we surface true cross-lexical synonyms.
      if (a.contentTokens.size === 0 || b.contentTokens.size === 0)
        continue
      let overlap = false
      for (const t of a.contentTokens) {
        if (b.contentTokens.has(t)) {
          overlap = true
          break
        }
      }
      if (overlap)
        continue

      let cosine = 0
      let sharedUrls = 0
      let topSharedUrl = ''
      let topSharedImp = -1
      for (const [url, wa] of a.vec) {
        const wb = b.vec.get(url)
        if (wb === undefined)
          continue
        sharedUrls++
        cosine += wa * wb
        const combinedUrlImp = (a.agg.urls.get(url)?.impressions ?? 0) + (b.agg.urls.get(url)?.impressions ?? 0)
        if (combinedUrlImp > topSharedImp || (combinedUrlImp === topSharedImp && url < topSharedUrl)) {
          topSharedImp = combinedUrlImp
          topSharedUrl = url
        }
      }

      if (sharedUrls < 2 || cosine < options.minCosine)
        continue

      const aFirst = a.agg.impressions > b.agg.impressions
        || (a.agg.impressions === b.agg.impressions && a.agg.query < b.agg.query)
      pairs.push({
        queryA: aFirst ? a.agg.query : b.agg.query,
        queryB: aFirst ? b.agg.query : a.agg.query,
        cosine: round4(Math.min(1, cosine)),
        sharedUrls,
        combinedImpressions: a.agg.impressions + b.agg.impressions,
        topSharedUrl,
      })
    }
  }

  pairs.sort((a, b) =>
    b.combinedImpressions - a.combinedImpressions
    || b.cosine - a.cosine
    || (a.queryA < b.queryA ? -1 : a.queryA > b.queryA ? 1 : 0)
    || (a.queryB < b.queryB ? -1 : a.queryB > b.queryB ? 1 : 0),
  )

  return pairs.slice(0, options.maxPairs)
}

export const urlClustersAnalyzer = defineAnalyzer<AnalysisParams, Row, UrlTopicCluster[]>({
  id: 'url-clusters',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 10

    const sql = `
      SELECT
        query,
        url,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.ctr} AS ctr,
        ${METRIC_EXPR.position} AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    `

    return {
      sql,
      params: [startDate, endDate, minImpressions > 0 ? 1 : 0],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const input: QueryPageRow[] = arr.map(r => ({
      query: str(r.query),
      page: str(r.url),
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      ctr: num(r.ctr),
      position: num(r.position),
    }))
    const minDominanceShare = clampShare(params.threshold)
    const result = analyzeUrlClusters(input, {
      minImpressions: params.minImpressions,
      minClusterSize: params.minClusterSize,
      minDominanceShare,
    })
    const paged = paginateInMemory(result.clusters, { limit: params.limit, offset: params.offset })
    return {
      results: paged,
      meta: {
        total: result.clusters.length,
        returned: paged.length,
        totalClusters: result.clusters.length,
        totalQueries: result.totalQueries,
        clusteredQueries: result.clusteredQueries,
        splitQueries: result.splitQueries,
        unclusteredQueries: result.unclusteredQueries,
        minDominanceShare,
        synonymPairs: result.synonymPairs,
      },
    }
  },

  buildRows(params) {
    return {
      rows: queriesQueryState(periodOf(params), fetchBudgetOf(params)),
    }
  },

  reduceRows(rows, params) {
    const arr = (Array.isArray(rows) ? rows : []) as unknown as QueryPageRow[]
    const minDominanceShare = clampShare(params.threshold)
    const result = analyzeUrlClusters(arr, {
      minImpressions: params.minImpressions,
      minClusterSize: params.minClusterSize,
      minDominanceShare,
    })
    const paged = paginateInMemory(result.clusters, { limit: params.limit, offset: params.offset })
    return {
      results: paged,
      meta: {
        total: result.clusters.length,
        returned: paged.length,
        totalClusters: result.clusters.length,
        totalQueries: result.totalQueries,
        clusteredQueries: result.clusteredQueries,
        splitQueries: result.splitQueries,
        unclusteredQueries: result.unclusteredQueries,
        minDominanceShare,
        synonymPairs: result.synonymPairs,
      },
    }
  },
})
