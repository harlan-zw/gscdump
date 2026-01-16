/**
 * Seasonality analysis - detects monthly traffic patterns.
 * Pure function operating on date-based metrics.
 */

import type { DateMetrics } from './types'

export type SeasonalityMetric = 'clicks' | 'impressions'

export interface SeasonalityOptions {
  /** Metric to analyze for seasonality. Default: clicks */
  metric?: SeasonalityMetric
}

export interface MonthlyData {
  month: string // 'YYYY-MM'
  value: number
  vsAverage: number // % vs overall average (1.0 = average)
  isPeak: boolean // >1.5x average
  isTrough: boolean // <0.5x average
}

export interface SeasonalityResult {
  hasSeasonality: boolean
  /** Coefficient of variation: std dev / mean. Higher = more seasonal. */
  strength: number
  peakMonths: string[] // e.g., ['11', '12'] for Nov-Dec
  troughMonths: string[] // e.g., ['06'] for June
  monthlyBreakdown: MonthlyData[]
  insufficientData: boolean // true if <12 months
}

/**
 * Calculates coefficient of variation (CV) as a seasonality strength measure.
 * CV = std dev / mean, capped at 1 for the result.
 */
function calculateCV(values: number[]): number {
  if (values.length === 0)
    return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean === 0)
    return 0
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  const stdDev = Math.sqrt(variance)
  return Math.min(stdDev / mean, 1)
}

/**
 * Detects seasonality patterns by analyzing monthly traffic variation.
 * Identifies peaks (>1.5x average) and troughs (<0.5x average).
 *
 * @param dates Array of date metrics (each row is one day)
 * @param options Analysis options
 */
export function analyzeSeasonality(
  dates: DateMetrics[],
  options: SeasonalityOptions = {},
): SeasonalityResult {
  const { metric = 'clicks' } = options

  if (dates.length === 0) {
    return {
      hasSeasonality: false,
      strength: 0,
      peakMonths: [],
      troughMonths: [],
      monthlyBreakdown: [],
      insufficientData: true,
    }
  }

  // Aggregate by month
  const monthlyMap = new Map<string, number>()

  for (const row of dates) {
    const month = row.date.substring(0, 7) // YYYY-MM
    const value = metric === 'clicks' ? row.clicks : row.impressions
    monthlyMap.set(month, (monthlyMap.get(month) || 0) + value)
  }

  const months = Array.from(monthlyMap.keys()).sort()
  const values = months.map(m => monthlyMap.get(m) || 0)

  const insufficientData = months.length < 12

  // Calculate average
  const totalValue = values.reduce((a, b) => a + b, 0)
  const avgValue = values.length > 0 ? totalValue / values.length : 0

  // Build monthly breakdown
  const monthlyBreakdown: MonthlyData[] = months.map((month, i) => {
    const value = values[i]
    const vsAverage = avgValue > 0 ? value / avgValue : 0
    return {
      month,
      value,
      vsAverage,
      isPeak: vsAverage > 1.5,
      isTrough: vsAverage < 0.5,
    }
  })

  // Extract peak/trough months (just the MM part)
  const peakMonths = [...new Set(
    monthlyBreakdown
      .filter(m => m.isPeak)
      .map(m => m.month.substring(5, 7)),
  )]

  const troughMonths = [...new Set(
    monthlyBreakdown
      .filter(m => m.isTrough)
      .map(m => m.month.substring(5, 7)),
  )]

  // Calculate strength (CV)
  const strength = calculateCV(values)

  // Determine if there's seasonality (has peaks/troughs or high CV)
  const hasSeasonality = peakMonths.length > 0 || troughMonths.length > 0 || strength > 0.3

  return {
    hasSeasonality,
    strength,
    peakMonths,
    troughMonths,
    monthlyBreakdown,
    insufficientData,
  }
}
