import type { GoogleSearchConsoleClient } from '../core/client'
import type { KeywordData } from '../api/search-analytics/types'
import type { BaseAnalysisOptions } from './types'
import { defaultQuery, executeAnalysisQuery } from './types'

export interface BrandSegmentationOptions extends BaseAnalysisOptions {
  /** Brand terms to match against keywords (case-insensitive) */
  brandTerms: string[]
  /** Minimum impressions for a keyword to be included. Default: 10 */
  minImpressions?: number
}

export interface BrandSegmentationSummary {
  brandClicks: number
  nonBrandClicks: number
  brandShare: number // 0-1
  brandImpressions: number
  nonBrandImpressions: number
}

export interface BrandSegmentationResult {
  brand: KeywordData[]
  nonBrand: KeywordData[]
  summary: BrandSegmentationSummary
}

/**
 * Segments keywords into brand and non-brand based on provided brand terms.
 * Simple string matching - keyword contains any brand term (case-insensitive).
 */
export async function analyzeBrandSegmentation(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: BrandSegmentationOptions,
): Promise<BrandSegmentationResult> {
  const {
    query = defaultQuery(),
    brandTerms,
    minImpressions = 10,
  } = options

  const lowerBrandTerms = brandTerms.map(t => t.toLowerCase())

  const { rows } = await executeAnalysisQuery(client, siteUrl, query, ['query'])

  const brand: KeywordData[] = []
  const nonBrand: KeywordData[] = []

  for (const row of rows) {
    const keyword = row.query || ''

    if (row.impressions < minImpressions)
      continue

    const keywordData: KeywordData = {
      dimension: 'query',
      keyword,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      keys: null,
    }

    const isBrand = lowerBrandTerms.some(term => keyword.toLowerCase().includes(term))

    if (isBrand)
      brand.push(keywordData)
    else
      nonBrand.push(keywordData)
  }

  const brandClicks = brand.reduce((sum, k) => sum + (k.clicks || 0), 0)
  const nonBrandClicks = nonBrand.reduce((sum, k) => sum + (k.clicks || 0), 0)
  const totalClicks = brandClicks + nonBrandClicks

  return {
    brand,
    nonBrand,
    summary: {
      brandClicks,
      nonBrandClicks,
      brandShare: totalClicks > 0 ? brandClicks / totalClicks : 0,
      brandImpressions: brand.reduce((sum, k) => sum + (k.impressions || 0), 0),
      nonBrandImpressions: nonBrand.reduce((sum, k) => sum + (k.impressions || 0), 0),
    },
  }
}
