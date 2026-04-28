/**
 * Unified `striking-distance` analyzer. Spike for the `defineAnalyzer`
 * pattern: one file owns the SQL plan, the row plan, the typed `InputRow`
 * contract, and the shared reducer.
 *
 * SQL and row plans both emit rows matching `StrikingDistanceInputRow`.
 * Filtering (`minPosition`/`maxPosition`/`minImpressions`/`maxCtr`),
 * derivation (`potentialClicks`), and sorting all live in the reducer, so
 * drift between plans cannot silently change results. A SQL-side `LIMIT`
 * push-down can be added later as an optional optimization, but the
 * correctness contract stays with the reducer.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { keywordsQueryState } from '../analyzer/adapt-rows'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { paginateInMemory } from '../analyzer/paginate'
import { periodOf } from '@gscdump/engine/period'
import { num } from '@gscdump/engine/analysis-types'

const DEFAULT_ROW_LIMIT = 25_000

/**
 * Row shape both plans produce. Field names match GSC's native columns so
 * the row-source path needs no rename step; the SQL plan aliases `url → page`.
 */
export interface StrikingDistanceInputRow {
  query: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface StrikingDistanceResult {
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  /** Estimated clicks at ~15% CTR (the average for positions 1–3). */
  potentialClicks: number
}

export const strikingDistanceAnalyzer = defineAnalyzer<
  AnalysisParams,
  StrikingDistanceInputRow,
  StrikingDistanceResult[]
>({
  id: 'striking-distance',

  reduce(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const minPosition = params.minPosition ?? 4
    const maxPosition = params.maxPosition ?? 20
    const minImpressions = params.minImpressions ?? 100
    const maxCtr = params.maxCtr ?? 0.05
    const limit = params.limit ?? 1000

    const results: StrikingDistanceResult[] = []
    for (const row of arr) {
      const position = num(row.position)
      const impressions = num(row.impressions)
      const ctr = num(row.ctr)
      const clicks = num(row.clicks)

      if (position < minPosition || position > maxPosition)
        continue
      if (impressions < minImpressions)
        continue
      if (ctr > maxCtr)
        continue

      results.push({
        keyword: String(row.query ?? ''),
        page: row.page == null ? null : String(row.page),
        clicks,
        impressions,
        ctr,
        position,
        potentialClicks: Math.round(impressions * 0.15),
      })
    }

    results.sort((a, b) => b.potentialClicks - a.potentialClicks)
    const paged = paginateInMemory(results, { limit, offset: params.offset })
    return { results: paged, meta: { total: results.length, returned: paged.length } }
  },

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    return {
      sql: `
    SELECT
      query,
      url AS page,
      CAST(SUM(clicks) AS DOUBLE) AS clicks,
      CAST(SUM(impressions) AS DOUBLE) AS impressions,
      CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
      SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
    FROM read_parquet({{FILES}}, union_by_name = true)
    WHERE date >= ? AND date <= ?
    GROUP BY query, url
  `,
      params: [startDate, endDate],
      current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  buildRows(params) {
    return {
      keywords: keywordsQueryState(periodOf(params), params.limit ?? DEFAULT_ROW_LIMIT),
    }
  },
})
