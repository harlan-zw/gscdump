/**
 * Brand segmentation analysis - separates brand vs non-brand traffic.
 * Pure function operating on keyword data.
 */

import type { KeywordData } from 'gscdump'
import { num } from './types'

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
  brand: KeywordData[]
  nonBrand: KeywordData[]
  summary: BrandSummary
}

/**
 * Segments keywords into brand and non-brand based on provided brand terms.
 * Simple string matching - keyword contains any brand term (case-insensitive).
 */
export function analyzeBrandSegmentation(
  keywords: KeywordData[],
  options: BrandSegmentationOptions,
): BrandSegmentationResult {
  const { brandTerms, minImpressions = 10 } = options

  const lowerBrandTerms = brandTerms.map(t => t.toLowerCase())

  const brand: KeywordData[] = []
  const nonBrand: KeywordData[] = []

  for (const row of keywords) {
    if (num(row.impressions) < minImpressions)
      continue

    const isBrand = lowerBrandTerms.some(term =>
      row.keyword.toLowerCase().includes(term),
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
