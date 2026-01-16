/**
 * Keyword clustering analysis - groups keywords by intent or prefix.
 * Pure function operating on keyword data.
 */

import type { KeywordData } from '../api/search-analytics/types'
import { num } from './types'

export type ClusterType = 'prefix' | 'intent' | 'both'

export interface ClusteringOptions {
  /** Minimum keywords for a cluster to be reported. Default: 2 */
  minClusterSize?: number
  /** Minimum impressions for a keyword to be included. Default: 10 */
  minImpressions?: number
  /** Clustering method. Default: 'both' */
  clusterBy?: ClusterType
}

export interface KeywordCluster {
  clusterName: string
  clusterType: 'prefix' | 'intent'
  keywords: KeywordData[]
  totalClicks: number
  totalImpressions: number
  avgPosition: number
  keywordCount: number
}

export interface ClusteringResult {
  clusters: KeywordCluster[]
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
 *
 * @param keywords Array of keyword data
 * @param options Clustering options
 */
export function analyzeClustering(
  keywords: KeywordData[],
  options: ClusteringOptions = {},
): ClusteringResult {
  const {
    minClusterSize = 2,
    minImpressions = 10,
    clusterBy = 'both',
  } = options

  // Filter by impressions
  const filtered = keywords.filter(k => num(k.impressions) >= minImpressions)

  const clusterMap = new Map<string, { type: 'prefix' | 'intent', keywords: KeywordData[] }>()
  const clusteredKeywords = new Set<string>()

  // Cluster by intent first (higher priority)
  if (clusterBy === 'intent' || clusterBy === 'both') {
    for (const kw of filtered) {
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
    const unclustered = filtered.filter(kw => !clusteredKeywords.has(kw.keyword))
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
  const clusters: KeywordCluster[] = []
  for (const [name, data] of clusterMap) {
    if (data.keywords.length < minClusterSize)
      continue

    const totalClicks = data.keywords.reduce((sum, k) => sum + num(k.clicks), 0)
    const totalImpressions = data.keywords.reduce((sum, k) => sum + num(k.impressions), 0)
    const avgPosition = data.keywords.reduce((sum, k) => sum + num(k.position), 0) / data.keywords.length

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

  const unclustered = filtered.filter(kw => !clusteredKeywords.has(kw.keyword))

  return { clusters, unclustered }
}
