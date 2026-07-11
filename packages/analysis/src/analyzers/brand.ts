/**
 * `brand` — segments queries into brand vs non-brand traffic. Both paths
 * require `params.brandTerms?.length` else throw. SQL applies a regex
 * `segment` label inline; the row path partitions a keyword stream by
 * substring match. Reducers preserve the legacy result shapes exactly so
 * downstream consumers continue to receive the same `meta.summary`.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { Result } from 'gscdump/result'
import type { AnalysisError } from '../errors'
import type { QueriesRow } from '../types'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { err, ok, unwrapResult } from 'gscdump/result'
import { queriesQueryState } from '../analyzer/adapt-rows'
import { rowString as str } from '../analyzer/row-values'
import { analysisErrors, analysisErrorToException } from '../errors'

export interface BrandSegmentationOptions {
  /** Brand terms to match against keywords (case-insensitive) */
  brandTerms: string[]
  /** Minimum impressions for a keyword to be included. Default: 10 */
  minImpressions?: number
}

export interface BrandSummary {
  brandClicks: number
  nonBrandClicks: number
  brandShare: number
  brandImpressions: number
  nonBrandImpressions: number
}

export interface BrandSegmentationResult {
  brand: QueriesRow[]
  nonBrand: QueriesRow[]
  summary: BrandSummary
}

export interface BrandResultRow {
  query: string
  page?: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  segment: 'brand' | 'non-brand'
}

function escapeRegexAlt(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `Result`-returning guard for the brand analyzer's one caller-actionable
 * precondition: the run must carry brand terms to segment by. Modelled (not a
 * defect) — a caller can re-run with `--brand-terms`. The `defineAnalyzer`
 * callbacks below are synchronous and the engine dispatcher expects them to
 * throw, so they call `requireBrandTerms`, the throwing wrapper that maps the
 * typed error through `analysisErrorToException`; the verbatim message
 * ("Brand analysis requires brandTerms") is preserved for existing assertions.
 */
function requireBrandTermsResult(
  brandTerms: string[] | undefined,
): Result<string[], AnalysisError> {
  return brandTerms?.length ? ok(brandTerms) : err(analysisErrors.missingBrandTerms())
}

function requireBrandTerms(brandTerms: string[] | undefined): string[] {
  return unwrapResult(requireBrandTermsResult(brandTerms), analysisErrorToException)
}

/**
 * Pure helper: segment keywords into brand and non-brand based on provided
 * brand terms. Re-exported from `@gscdump/analysis` for portable callers.
 */
export function analyzeBrandSegmentation(
  keywords: QueriesRow[],
  options: BrandSegmentationOptions,
): BrandSegmentationResult {
  const { brandTerms, minImpressions = 10 } = options

  const lowerBrandTerms = brandTerms.map(t => t.toLowerCase())

  const brand: QueriesRow[] = []
  const nonBrand: QueriesRow[] = []
  let brandClicks = 0
  let nonBrandClicks = 0
  let brandImpressions = 0
  let nonBrandImpressions = 0

  for (const row of keywords) {
    const impressions = num(row.impressions)
    if (impressions < minImpressions)
      continue

    const clicks = num(row.clicks)
    const query = row.query.toLowerCase()
    const isBrand = lowerBrandTerms.some(term =>
      query.includes(term),
    )

    if (isBrand) {
      brand.push(row)
      brandClicks += clicks
      brandImpressions += impressions
    }
    else {
      nonBrand.push(row)
      nonBrandClicks += clicks
      nonBrandImpressions += impressions
    }
  }

  const totalClicks = brandClicks + nonBrandClicks

  return {
    brand,
    nonBrand,
    summary: {
      brandClicks,
      nonBrandClicks,
      brandShare: totalClicks > 0 ? brandClicks / totalClicks : 0,
      brandImpressions,
      nonBrandImpressions,
    },
  }
}

export const brandAnalyzer = defineAnalyzer<AnalysisParams, Row, BrandResultRow[]>({
  id: 'brand',

  buildSql(params) {
    const brandTerms = requireBrandTerms(params.brandTerms)
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 10
    const limit = params.limit ?? 10000

    const regex = `(${brandTerms.map(t => escapeRegexAlt(t.toLowerCase())).join('|')})`

    const sql = `
    WITH agg AS (
      SELECT
        query,
        url AS page,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.ctr} AS ctr,
        ${METRIC_EXPR.position} AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    )
    SELECT
      query, page, clicks, impressions, ctr, position,
      CASE WHEN regexp_matches(LOWER(query), ?) THEN 'brand' ELSE 'non-brand' END AS segment
    FROM agg
    ORDER BY clicks DESC
    LIMIT ${Number(limit)}
  `

    return {
      sql,
      params: [startDate, endDate, minImpressions, regex],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    const normalized: BrandResultRow[] = arr.map(r => ({
      query: str(r.query),
      page: r.page == null ? undefined : str(r.page),
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      ctr: num(r.ctr),
      position: num(r.position),
      segment: str(r.segment) as 'brand' | 'non-brand',
    }))
    let brandClicks = 0
    let nonBrandClicks = 0
    let brandImpressions = 0
    let nonBrandImpressions = 0
    for (const r of normalized) {
      if (r.segment === 'brand') {
        brandClicks += r.clicks
        brandImpressions += r.impressions
      }
      else {
        nonBrandClicks += r.clicks
        nonBrandImpressions += r.impressions
      }
    }
    const totalClicks = brandClicks + nonBrandClicks
    return {
      results: normalized,
      meta: {
        total: normalized.length,
        summary: {
          brandClicks,
          nonBrandClicks,
          brandShare: totalClicks > 0 ? brandClicks / totalClicks : 0,
          brandImpressions,
          nonBrandImpressions,
        },
      },
    }
  },

  buildRows(params) {
    return {
      queries: queriesQueryState(periodOf(params), params.limit),
    }
  },

  reduceRows(rows, params) {
    const brandTerms = requireBrandTerms(params.brandTerms)
    const keywords = (Array.isArray(rows) ? rows : []) as unknown as QueriesRow[]
    const result = analyzeBrandSegmentation(keywords, {
      brandTerms,
      minImpressions: params.minImpressions,
    })
    return {
      results: [
        ...result.brand.map(r => ({ ...r, segment: 'brand' as const })),
        ...result.nonBrand.map(r => ({ ...r, segment: 'non-brand' as const })),
      ] as BrandResultRow[],
      meta: { summary: result.summary },
    }
  },
})
