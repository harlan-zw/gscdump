/**
 * `brand` — segments queries into brand vs non-brand traffic. Both paths
 * require `params.brandTerms?.length` else throw. SQL applies a regex
 * `segment` label inline; the row path partitions a keyword stream by
 * substring match. Reducers preserve the legacy result shapes exactly so
 * downstream consumers continue to receive the same `meta.summary`.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams, KeywordRow } from '../types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { keywordsQueryState } from '../analyzer/adapt-rows'
import { defineAnalyzer } from '../analyzer/define'
import { periodOf } from '../period'
import { num } from '../types'

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
  brand: KeywordRow[]
  nonBrand: KeywordRow[]
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

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * Pure helper: segment keywords into brand and non-brand based on provided
 * brand terms. Re-exported from `@gscdump/analysis` for portable callers.
 */
export function analyzeBrandSegmentation(
  keywords: KeywordRow[],
  options: BrandSegmentationOptions,
): BrandSegmentationResult {
  const { brandTerms, minImpressions = 10 } = options

  const lowerBrandTerms = brandTerms.map(t => t.toLowerCase())

  const brand: KeywordRow[] = []
  const nonBrand: KeywordRow[] = []

  for (const row of keywords) {
    if (num(row.impressions) < minImpressions)
      continue

    const isBrand = lowerBrandTerms.some(term =>
      row.query.toLowerCase().includes(term),
    )

    if (isBrand)
      brand.push(row)
    else
      nonBrand.push(row)
  }

  const brandClicks = brand.reduce((sum, k) => sum + num(k.clicks), 0)
  const nonBrandClicks = nonBrand.reduce((sum, k) => sum + num(k.clicks), 0)
  const totalClicks = brandClicks + nonBrandClicks

  return {
    brand,
    nonBrand,
    summary: {
      brandClicks,
      nonBrandClicks,
      brandShare: totalClicks > 0 ? brandClicks / totalClicks : 0,
      brandImpressions: brand.reduce((sum, k) => sum + num(k.impressions), 0),
      nonBrandImpressions: nonBrand.reduce((sum, k) => sum + num(k.impressions), 0),
    },
  }
}

export const brandAnalyzer = defineAnalyzer<AnalysisParams, Row, BrandResultRow[]>({
  id: 'brand',

  buildSql(params) {
    if (!params.brandTerms?.length)
      throw new Error('Brand analysis requires brandTerms')
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 10
    const limit = params.limit ?? 10000

    const regex = `(${params.brandTerms.map(t => escapeRegexAlt(t.toLowerCase())).join('|')})`

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
      current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
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
      keywords: keywordsQueryState(periodOf(params), params.limit),
    }
  },

  reduceRows(rows, params) {
    if (!params.brandTerms?.length)
      throw new Error('Brand analysis requires brandTerms')
    const keywords = (Array.isArray(rows) ? rows : []) as unknown as KeywordRow[]
    const result = analyzeBrandSegmentation(keywords, {
      brandTerms: params.brandTerms,
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
