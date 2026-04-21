import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { bool, num, period, str } from '../shared'

export function buildSeasonality(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const metric = params.metric === 'impressions' ? 'impressions' : 'clicks'

  const sql = `
    WITH monthly AS (
      SELECT
        strftime(date, '%Y-%m') AS month,
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
    shape: (rows) => {
      const breakdown = rows.map(r => ({
        month: str(r.month),
        value: num(r.value),
        vsAverage: num(r.vsAverage),
        isPeak: bool(r.isPeak),
        isTrough: bool(r.isTrough),
      }))
      const first = rows[0]
      const strength = first ? num(first.strength) : 0
      const monthCount = first ? num(first.monthCount) : 0
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
  }
}
