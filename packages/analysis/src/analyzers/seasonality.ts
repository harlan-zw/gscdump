/**
 * `seasonality` — detects monthly traffic patterns. SQL aggregates monthly
 * sums + coefficient of variation in a single statement; the row reducer
 * recomputes the same shape from a date stream. Both paths emit the same
 * `MonthlyData[]` results plus `{ strength }` meta.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { DateRow } from '../types'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { datesQueryState } from '../analyzer/adapt-rows'
import { rowBoolean as bool, rowString as str } from '../analyzer/row-values'

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
 * Pure helper: detects seasonality patterns by analyzing monthly traffic
 * variation. Re-exported from `@gscdump/analysis` for portable callers.
 */
export function analyzeSeasonality(
  dates: DateRow[],
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

  const monthlyMap = new Map<string, number>()

  for (const row of dates) {
    const month = row.date.substring(0, 7)
    const value = metric === 'clicks' ? row.clicks : row.impressions
    monthlyMap.set(month, (monthlyMap.get(month) || 0) + value)
  }

  const months = Array.from(monthlyMap.keys()).sort()
  const values = months.map(m => monthlyMap.get(m) || 0)

  const insufficientData = months.length < 12

  const totalValue = values.reduce((a, b) => a + b, 0)
  const avgValue = values.length > 0 ? totalValue / values.length : 0

  const monthlyBreakdown: MonthlyData[] = months.map((month, i) => {
    const value = values[i] ?? 0
    const vsAverage = avgValue > 0 ? value / avgValue : 0
    return {
      month,
      value,
      vsAverage,
      isPeak: vsAverage > 1.5,
      isTrough: vsAverage < 0.5,
    }
  })

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

  const strength = calculateCV(values)
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

export const seasonalityAnalyzer = defineAnalyzer<AnalysisParams, Row, MonthlyData[]>({
  id: 'seasonality',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const metric = params.metric === 'impressions' ? 'impressions' : 'clicks'

    // CAST(date AS DATE) defends against union_by_name=true coercing the
    // `date` column to VARCHAR when one of the attached parquets stores it as
    // a string. strftime only accepts DATE/TIMESTAMP; without the cast a
    // browser-engine run binder-errors and forces a server fallback. Same
    // pattern as content-velocity.
    const sql = `
      WITH monthly AS (
        SELECT
          strftime(CAST(date AS DATE), '%Y-%m') AS month,
          CAST(SUM(${metric}) AS DOUBLE) AS value
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
        GROUP BY month
      ),
      stats AS (
        SELECT
          AVG(value) AS avg_val,
          COALESCE(STDDEV_POP(value), 0.0) AS std_val,
          CAST(COUNT(*) AS DOUBLE) AS month_count
        FROM monthly
      )
      SELECT
        m.month AS month,
        m.value AS value,
        CASE WHEN s.avg_val > 0 THEN m.value / s.avg_val ELSE 0.0 END AS vsAverage,
        (s.avg_val > 0 AND m.value / s.avg_val > 1.5) AS isPeak,
        (s.avg_val > 0 AND m.value / s.avg_val < 0.5) AS isTrough,
        CASE WHEN s.avg_val > 0 THEN LEAST(s.std_val / s.avg_val, 1.0) ELSE 0.0 END AS strength,
        s.month_count AS monthCount
      FROM monthly m, stats s
      ORDER BY m.month
    `

    return {
      sql,
      params: [startDate, endDate],
      current: { table: 'pages', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    const breakdown: MonthlyData[] = arr.map(r => ({
      month: str(r.month),
      value: num(r.value),
      vsAverage: num(r.vsAverage),
      isPeak: bool(r.isPeak),
      isTrough: bool(r.isTrough),
    }))
    const first = arr[0]
    const strength = first ? num((first as any).strength) : 0
    const monthCount = first ? num((first as any).monthCount) : 0
    const peakMonths = [...new Set(
      breakdown.filter(m => m.isPeak).map(m => m.month.substring(5, 7)),
    )]
    const troughMonths = [...new Set(
      breakdown.filter(m => m.isTrough).map(m => m.month.substring(5, 7)),
    )]
    const hasSeasonality = peakMonths.length > 0 || troughMonths.length > 0 || strength > 0.3
    const insufficientData = monthCount < 12
    return {
      results: breakdown,
      meta: {
        total: breakdown.length,
        hasSeasonality,
        strength,
        peakMonths,
        troughMonths,
        insufficientData,
      },
    }
  },

  buildRows(params) {
    return {
      dates: datesQueryState(periodOf(params), params.limit),
    }
  },

  reduceRows(rows, params) {
    const dates = (Array.isArray(rows) ? rows : []) as unknown as DateRow[]
    const result = analyzeSeasonality(dates, { metric: params.metric as SeasonalityMetric | undefined })
    return { results: result.monthlyBreakdown, meta: { strength: result.strength } }
  },
})
