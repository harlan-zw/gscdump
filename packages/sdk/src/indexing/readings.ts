// A Site's indexing read, parsed once at the boundary.
//
// Ported from the ingestion step in nuxtseo.com
// `layers/saas/app/composables/useDashboardSiteData.ts`, which request-indexing
// copied as `readSiteIndexing` in `app/utils/fleet-indexing.ts`.
//
// The index rate is the share of inspected URLs indexed, so it caps at 100%.
// When the denominator collapses upstream, the hosted figure can pass 100%
// (one Site read over 1700%), so the parse clamps it once. A null indexed count
// means unknown. Reading it as zero would report every URL as not indexed, so
// the parse derives it from the clamped rate instead.

import type { GscdumpIndexingResponse, GscdumpIndexingTrendPoint } from '@gscdump/contracts'

type IssueKey = 'notFound' | 'soft404' | 'serverError' | 'blockedByRobots'
type CoverageKey = 'crawledNotIndexed' | 'discoveredNotCrawled'
type SignalKey = 'richResultsPass' | 'richResultsFail'

/**
 * One day of a Site's indexing trend, with no null counts and a rate within
 * 0 to 100. The field names are those of `GscdumpIndexingTrendPoint`.
 */
export interface IndexingTrendReading {
  /** `YYYY-MM-DD`. */
  date: GscdumpIndexingTrendPoint['date']
  totalUrls: number
  indexedCount: number
  /** 0 to 100. */
  indexedPercent: number
  issues?: { [Key in IssueKey]?: number }
  /** Google's "knows about it and chose not to index it" counts. */
  coverage?: { [Key in CoverageKey]?: number }
  signals?: { [Key in SignalKey]?: number }
}

/** A Site's latest indexing summary, with its rate changes in points. */
export interface IndexingSummaryReading {
  indexed: number
  totalUrls: number
  /** 0 to 100. */
  indexedPercent: number
  change7d?: number | null
  change28d?: number | null
}

export interface SiteIndexingReadings {
  summary: IndexingSummaryReading
  /** Oldest first, as the hosted read returns it. */
  trend: IndexingTrendReading[]
}

/** Clamp an index rate to 0 to 100. */
export function clampIndexedPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function count(value: number | null | undefined): number | undefined {
  return value ?? undefined
}

/** Parse one hosted Site indexing read into the readings every portfolio function takes. */
export function readSiteIndexing(response: Pick<GscdumpIndexingResponse, 'summary' | 'trend'>): SiteIndexingReadings {
  return {
    summary: {
      indexed: response.summary.indexed,
      totalUrls: response.summary.totalUrls,
      indexedPercent: clampIndexedPercent(response.summary.indexedPercent),
      change7d: response.summary.change7d,
      change28d: response.summary.change28d,
    },
    trend: response.trend.map((point) => {
      const indexedPercent = clampIndexedPercent(point.indexedPercent)
      return {
        date: point.date,
        indexedPercent,
        indexedCount: point.indexedCount ?? Math.round(point.totalUrls * indexedPercent / 100),
        totalUrls: point.totalUrls,
        issues: {
          notFound: count(point.issues.notFound),
          soft404: count(point.issues.soft404),
          serverError: count(point.issues.serverError),
          blockedByRobots: count(point.issues.blockedByRobots),
        },
        coverage: {
          crawledNotIndexed: count(point.coverage?.crawledNotIndexed),
          discoveredNotCrawled: count(point.coverage?.discoveredNotCrawled),
        },
        signals: {
          richResultsPass: count(point.signals.richResultsPass),
          richResultsFail: count(point.signals.richResultsFail),
        },
      }
    }),
  }
}

/** Inspected URLs that are not indexed on this day. Never negative. */
export function notIndexedCount(point: Pick<IndexingTrendReading, 'indexedCount' | 'totalUrls'>): number {
  return Math.max(0, point.totalUrls - (point.indexedCount ?? 0))
}

/** Crawl errors on one reading: not found, soft 404, and server errors. */
export function crawlErrorCount(point: Pick<IndexingTrendReading, 'issues'>): number {
  return (point.issues?.notFound ?? 0) + (point.issues?.soft404 ?? 0) + (point.issues?.serverError ?? 0)
}
