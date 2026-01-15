import type { GoogleSearchConsoleClient } from '../core/client'
import type { KeywordData } from '../api/search-analytics/types'
import type { BaseAnalysisOptions } from './types'
import { defaultQuery, executeAnalysisQuery } from './types'

export type ClusterType = 'prefix' | 'intent' | 'both'

export interface QueryClusteringOptions extends BaseAnalysisOptions {
  /** Minimum keywords for a cluster to be reported. Default: 2 */
  minClusterSize?: number
  /** Minimum impressions for a keyword to be included. Default: 10 */
  minImpressions?: number
  /** Clustering method. Default: 'both' */
  clusterBy?: ClusterType
}

export interface QueryCluster {
  clusterName: string
  clusterType: 'prefix' | 'intent'
  keywords: KeywordData[]
  totalClicks: number
  totalImpressions: number
  avgPosition: number
  keywordCount: number
}

export interface QueryClusteringResult {
  clusters: QueryCluster[]
  unclustered: KeywordData[]
}

// Intent prefixes commonly used in searches
const INTENT_PREFIXES = [
  'how to',
  'what is',
  'what are',
  'why is',
  'why do',
  'where to',
  'when to',
  'best',
  'top',
  'vs',
  'versus',
  'compare',
  'review',
  'buy',
  'cheap',
  'free',
  'near me',
]

function extractIntentPrefix(keyword: string): string | null {
  const lower = keyword.toLowerCase()
  for (const prefix of INTENT_PREFIXES) {
    if (lower.startsWith(prefix + ' ') || lower.startsWith(prefix))
      return prefix
  }
  return null
}

function extractWordPrefix(keyword: string, wordCount = 2): string | null {
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length < wordCount + 1)
    return null // Need more words than prefix to cluster
  return words.slice(0, wordCount).join(' ')
}

/**
 * Clusters keywords by intent prefix or common word prefix.
 * Simple regex/prefix approach - no external NLP dependencies.
 */
export async function analyzeQueryClustering(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryClusteringOptions = {},
): Promise<QueryClusteringResult> {
  const {
    query = defaultQuery(),
    minClusterSize = 2,
    minImpressions = 10,
    clusterBy = 'both',
  } = options

  const { rows } = await executeAnalysisQuery(client, siteUrl, query, ['query'])

  // Convert to KeywordData
  const keywords: KeywordData[] = rows
    .filter(row => row.impressions >= minImpressions)
    .map(row => ({
      dimension: 'query' as const,
      keyword: row.query || '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      keys: null,
    }))

  const clusterMap = new Map<string, { type: 'prefix' | 'intent', keywords: KeywordData[] }>()
  const clusteredKeywords = new Set<string>()

  // Cluster by intent first (higher priority)
  if (clusterBy === 'intent' || clusterBy === 'both') {
    for (const kw of keywords) {
      const intent = extractIntentPrefix(kw.keyword)
      if (intent) {
        const existing = clusterMap.get(intent)
        if (existing) {
          existing.keywords.push(kw)
        }
        else {
          clusterMap.set(intent, { type: 'intent', keywords: [kw] })
        }
        clusteredKeywords.add(kw.keyword)
      }
    }
  }

  // Cluster by prefix for unclustered keywords
  if (clusterBy === 'prefix' || clusterBy === 'both') {
    const unclustered = keywords.filter(kw => !clusteredKeywords.has(kw.keyword))
    const prefixMap = new Map<string, KeywordData[]>()

    for (const kw of unclustered) {
      const prefix = extractWordPrefix(kw.keyword)
      if (prefix) {
        const existing = prefixMap.get(prefix)
        if (existing)
          existing.push(kw)
        else
          prefixMap.set(prefix, [kw])
      }
    }

    // Add valid prefix clusters
    for (const [prefix, kws] of prefixMap) {
      if (kws.length >= minClusterSize) {
        clusterMap.set(prefix, { type: 'prefix', keywords: kws })
        kws.forEach(kw => clusteredKeywords.add(kw.keyword))
      }
    }
  }

  // Build result clusters, filtering by minClusterSize
  const clusters: QueryCluster[] = []
  for (const [name, data] of clusterMap) {
    if (data.keywords.length < minClusterSize)
      continue

    const totalClicks = data.keywords.reduce((sum, k) => sum + (k.clicks || 0), 0)
    const totalImpressions = data.keywords.reduce((sum, k) => sum + (k.impressions || 0), 0)
    const avgPosition = data.keywords.reduce((sum, k) => sum + (k.position || 0), 0) / data.keywords.length

    clusters.push({
      clusterName: name,
      clusterType: data.type,
      keywords: data.keywords,
      totalClicks,
      totalImpressions,
      avgPosition,
      keywordCount: data.keywords.length,
    })
  }

  // Sort by total clicks desc
  clusters.sort((a, b) => b.totalClicks - a.totalClicks)

  const unclustered = keywords.filter(kw => !clusteredKeywords.has(kw.keyword))

  return { clusters, unclustered }
}
