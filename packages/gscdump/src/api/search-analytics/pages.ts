import type { GoogleSearchConsoleClient } from '../../core/client'
import type { ComparisonResult, FetchPageResult, PageData, QueryOptions } from './types'
import { percentDifference } from '../../utils/format'
import { createQueryBody, queryRecursive } from './query'
import { extractDomain, formatPageForQuery } from './utils'

export interface Page { page: string }

/**
 * Fetches all pages with their performance data using recursive pagination.
 */
export async function fetchPages(client: GoogleSearchConsoleClient, siteUrl: string, options: QueryOptions = {}): Promise<Page[]> {
  const period = await queryRecursive(client, siteUrl, {
    ...createQueryBody(options),
    dimensions: ['page'],
  }).then(d => d.rows)
  return period.map(row => ({
    ...row,
    page: row.keys?.[0] || '',
  }))
}

/**
 * Fetches page performance data with period comparison, including top keyword per page.
 */
export async function fetchPagesWithComparison(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<ComparisonResult<PageData>> {
  const [currentPages, previousPages, keywords] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
      dimensions: ['page'],
    }).then(res => res.rows || []),
    options.prevPeriod
      ? client.searchAnalytics.query(siteUrl, {
          ...createQueryBody({ ...options, period: options.prevPeriod }),
          dimensions: ['page'],
        }).then(res => res.rows || [])
      : Promise.resolve([]),
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
      dimensions: ['query', 'page'],
    }).then(res => res.rows || []),
  ])

  const current = currentPages.map((row) => {
    const prevRow = previousPages.find(r => r.keys?.[0] === row.keys?.[0])
    const keyword = keywords.find(r => r.keys?.[1] === row.keys?.[0])
    const clicks = row.clicks ?? 0
    const impressions = row.impressions ?? 0
    const prevClicks = prevRow?.clicks ?? 0
    const prevImpressions = prevRow?.impressions ?? 0
    return {
      ...row,
      dimension: 'page' as const,
      page: row.keys?.[0] || '',
      keyword: keyword?.keys?.[0] || undefined,
      keywordPosition: keyword?.position ?? 0,
      clicks,
      prevClicks,
      clicksPercent: percentDifference(clicks, prevClicks),
      impressions,
      impressionsPercent: percentDifference(impressions, prevImpressions),
      prevImpressions,
      keys: null,
    }
  })

  const previous = previousPages.map((prevRow) => {
    const pageKey = prevRow.keys?.[0] || ''
    const currentRow = currentPages.find(r => r.keys?.[0] === pageKey)
    if (!currentRow) {
      return {
        ...prevRow,
        dimension: 'page' as const,
        page: pageKey,
        lost: true,
        clicks: 0,
        impressions: 0,
        prevClicks: prevRow.clicks ?? 0,
        prevImpressions: prevRow.impressions ?? 0,
        keys: null,
      }
    }
    return { ...prevRow, dimension: 'page' as const, page: pageKey, keys: null }
  })

  return {
    current,
    previous,
    metadata: {
      currentCount: current.length,
      previousCount: previous.length,
      keywordMatches: keywords.length,
    },
  }
}

export interface FetchPageOptions extends QueryOptions {
  /** Maximum keywords to return. Default: 5 */
  rowLimit?: number
}

/**
 * Fetches detailed data for a specific page including daily trends and top keywords.
 */
export async function fetchPage(client: GoogleSearchConsoleClient, siteUrl: string, url: string, options: FetchPageOptions = {}): Promise<FetchPageResult> {
  const { rowLimit = 5, ...queryOptions } = options
  const [dates, keywords] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody({
        ...queryOptions,
        filters: [{ dimension: 'page', operator: 'equals', expression: formatPageForQuery(url, extractDomain(siteUrl)) }],
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
        filters: [{ dimension: 'page', operator: 'equals', expression: formatPageForQuery(url, extractDomain(siteUrl)) }],
      }),
      rowLimit,
      dimensions: ['query'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      keyword: row.keys?.[0] || '',
      keys: null,
    }))),
  ])
  return { dates, keywords }
}
