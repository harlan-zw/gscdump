import type { GoogleSearchConsoleClient } from '../../core/client'
import { percentDifference } from '../../utils/format'
import { createQueryBody, queryRecursive } from './query'
import type { ComparisonResult, FetchKeywordResult, KeywordData, QueryOptions } from './types'
import { extractDomain, normalizePagePath } from './utils'

/**
 * Fetches keyword/query performance data with period comparison and associated pages.
 */
export async function fetchKeywordsWithComparison(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<ComparisonResult<KeywordData>> {
  const [currentKeywords, previousKeywords, pages] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
      dimensions: ['query'],
    }).then(res => res.rows || []),
    options.prevPeriod
      ? client.searchAnalytics.query(siteUrl, {
          ...createQueryBody({ ...options, period: options.prevPeriod }),
          dimensions: ['query'],
        }).then(res => res.rows || [])
      : Promise.resolve([]),
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
      dimensions: ['page', 'query'],
    }).then(res => res.rows || []),
  ])

  const current = currentKeywords.map((row) => {
    const prevRow = previousKeywords.find(r => r.keys?.[0] === row.keys?.[0])
    const pageMatch = pages.find(r => r.keys?.[1] === row.keys?.[0])
    const position = row.position ?? 0
    const ctr = row.ctr ?? 0
    const prevPosition = prevRow?.position ?? 0
    const prevCtr = prevRow?.ctr ?? 0
    return {
      ...row,
      dimension: 'query' as const,
      keyword: row.keys?.[0] || '',
      page: pageMatch?.keys?.[0] ? normalizePagePath(pageMatch.keys[0], siteUrl) : null,
      position,
      positionPercent: percentDifference(position, prevPosition),
      prevPosition,
      ctr,
      ctrPercent: percentDifference(ctr, prevCtr),
      prevCtr,
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      keys: null,
    }
  })

  const previous = previousKeywords.map((prevRow) => {
    const keywordKey = prevRow.keys?.[0] || ''
    const currentRow = currentKeywords.find(r => r.keys?.[0] === keywordKey)
    const pageMatch = pages.find(r => r.keys?.[1] === keywordKey)
    if (!currentRow) {
      return {
        ...prevRow,
        dimension: 'query' as const,
        keyword: keywordKey,
        page: pageMatch?.keys?.[0] ? normalizePagePath(pageMatch.keys[0], siteUrl) : null,
        lost: true,
        clicks: 0,
        position: 0,
        ctr: 0,
        prevCtr: prevRow.ctr ?? 0,
        prevPosition: prevRow.position ?? 0,
        prevClicks: prevRow.clicks ?? 0,
        prevImpressions: prevRow.impressions ?? 0,
        keys: null,
      }
    }
    return {
      ...prevRow,
      dimension: 'query' as const,
      keyword: keywordKey,
      page: pageMatch?.keys?.[0] ? normalizePagePath(pageMatch.keys[0], siteUrl) : null,
      keys: null,
    }
  })

  return {
    current,
    previous,
    metadata: {
      currentCount: current.length,
      previousCount: previous.length,
      pageMatches: pages.length,
    },
  }
}

/**
 * Fetches all keywords with their performance data using recursive pagination.
 */
export async function fetchKeywords(client: GoogleSearchConsoleClient, siteUrl: string, options: QueryOptions = {}): Promise<KeywordData[]> {
  const { rows } = await queryRecursive(client, siteUrl, {
    ...createQueryBody(options),
    dimensions: ['query'],
  })

  return rows.map(row => ({
    ...row,
    dimension: 'query' as const,
    keyword: row.keys?.[0] || '',
    keys: null,
  }))
}

export interface FetchKeywordOptions extends QueryOptions {
  /** Maximum pages to return. Default: 5 */
  rowLimit?: number
}

/**
 * Fetches detailed data for a specific keyword including daily trends and top pages.
 */
export async function fetchKeyword(client: GoogleSearchConsoleClient, siteUrl: string, keyword: string, options: FetchKeywordOptions = {}): Promise<FetchKeywordResult> {
  const { rowLimit = 5, ...queryOptions } = options
  const [dates, pages] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody({
        ...queryOptions,
        filters: [{ dimension: 'query', operator: 'equals', expression: keyword }],
      }),
      dimensions: ['date'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      date: row.keys?.[0] ?? '',
      keys: null,
    }))),
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody({
        ...queryOptions,
        filters: [{ dimension: 'query', operator: 'equals', expression: keyword }],
      }),
      rowLimit,
      dimensions: ['page'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      page: normalizePagePath(row.keys?.[0] || '', extractDomain(siteUrl)),
      keys: null,
    }))),
  ])
  return { dates, pages }
}
