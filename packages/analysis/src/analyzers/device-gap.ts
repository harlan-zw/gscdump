/**
 * device-gap — desktop vs mobile CTR/position delta over time.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams } from '../types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { defineAnalyzer } from '../analyzer/define'
import { periodOf } from '../period'
import { num } from '../types'

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

interface DeviceDayMetrics { clicks: number, impressions: number, ctr: number, position: number }
interface DeviceDayRow {
  date: string
  device: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface DeviceGapResult {
  date: string
  desktop: DeviceDayMetrics
  mobile: DeviceDayMetrics
  gaps: { ctrGap: number, positionGap: number }
}

export const deviceGapAnalyzer = defineAnalyzer<AnalysisParams, Row, DeviceGapResult[]>({
  id: 'device-gap',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const sql = `
    SELECT
      date,
      device,
      ${METRIC_EXPR.clicks} AS clicks,
      ${METRIC_EXPR.impressions} AS impressions,
      ${METRIC_EXPR.ctr} AS ctr,
      ${METRIC_EXPR.position} AS position
    FROM read_parquet({{FILES}}, union_by_name = true)
    WHERE date >= ? AND date <= ?
    GROUP BY date, device
    ORDER BY date ASC
  `
    return {
      sql,
      params: [startDate, endDate],
      current: { table: 'devices', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const { startDate, endDate } = periodOf(params)
    const typed = arr.map(r => ({
      date: str(r.date),
      device: str(r.device).toUpperCase(),
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      ctr: num(r.ctr),
      position: num(r.position),
    })) as DeviceDayRow[]

    const byDate = new Map<string, { desktop?: DeviceDayMetrics, mobile?: DeviceDayMetrics }>()
    for (const r of typed) {
      const entry = byDate.get(r.date) ?? {}
      const metrics: DeviceDayMetrics = {
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }
      if (r.device === 'DESKTOP')
        entry.desktop = metrics
      else if (r.device === 'MOBILE')
        entry.mobile = metrics
      byDate.set(r.date, entry)
    }

    const zero: DeviceDayMetrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 }
    const daily = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, sides]) => {
        const d = sides.desktop ?? zero
        const m = sides.mobile ?? zero
        return {
          date,
          desktop: d,
          mobile: m,
          gaps: {
            ctrGap: d.ctr - m.ctr,
            positionGap: m.position - d.position,
          },
        }
      })

    // First-week vs last-week average to classify trend.
    const weekly = (start: number, end: number): { ctr: number, pos: number } => {
      const slice = daily.slice(start, end)
      if (slice.length === 0)
        return { ctr: 0, pos: 0 }
      const sum = slice.reduce(
        (acc, d) => ({
          ctr: acc.ctr + d.gaps.ctrGap,
          pos: acc.pos + d.gaps.positionGap,
        }),
        { ctr: 0, pos: 0 },
      )
      return { ctr: sum.ctr / slice.length, pos: sum.pos / slice.length }
    }
    const first = weekly(0, 7)
    const last = weekly(Math.max(0, daily.length - 7), daily.length)
    const classify = (firstVal: number, lastVal: number): 'stable' | 'improving' | 'worsening' => {
      const diff = Math.abs(lastVal) - Math.abs(firstVal)
      if (Math.abs(diff) < 0.005)
        return 'stable' as const
      return diff < 0 ? ('improving' as const) : ('worsening' as const)
    }
    const avgCtrGap = daily.reduce((s, d) => s + d.gaps.ctrGap, 0) / Math.max(1, daily.length)
    const avgPositionGap = daily.reduce((s, d) => s + d.gaps.positionGap, 0) / Math.max(1, daily.length)

    return {
      results: daily,
      meta: {
        summary: {
          avgCtrGap,
          avgPositionGap,
          ctrGapTrend: classify(first.ctr, last.ctr),
          positionGapTrend: classify(first.pos, last.pos),
        },
        startDate,
        endDate,
      },
    }
  },
})
