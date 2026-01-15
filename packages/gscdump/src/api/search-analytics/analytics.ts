import type { GoogleSearchConsoleClient } from '../../core/client'
import { createQueryBody } from './query'
import type { AnalyticsData, ComparisonResult, QueryOptions } from './types'

/**
 * Fetches overall site analytics summary with period comparison and keyword data.
 */
export async function fetchAnalyticsWithComparison(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<ComparisonResult<AnalyticsData>> {
  const [currentSummary, previousSummary, currentKeywords, previousKeywords] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
    }).then(res => (res.rows || [])[0] || {}),
    options.prevPeriod
      ? client.searchAnalytics.query(siteUrl, {
          ...createQueryBody({ ...options, period: options.prevPeriod }),
        }).then(res => (res.rows || [])[0] || {})
      : Promise.resolve({}),
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
      dimensions: ['date', 'query'],
    }).then(res => res.rows || []),
    options.prevPeriod
      ? client.searchAnalytics.query(siteUrl, {
          ...createQueryBody({ ...options, period: options.prevPeriod }),
          dimensions: ['date', 'query'],
        }).then(res => res.rows || [])
      : Promise.resolve([]),
  ])

  return {
    current: [{ ...currentSummary, keywords: currentKeywords }],
    previous: [{ ...previousSummary, keywords: previousKeywords }],
    metadata: {
      currentCount: 1,
      previousCount: options.prevPeriod ? 1 : 0,
      currentKeywordCount: currentKeywords.length,
      previousKeywordCount: previousKeywords.length,
    },
  }
}
