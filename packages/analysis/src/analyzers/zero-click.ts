/**
 * `zero-click` — high impressions, low CTR, good ranking. SQL groups by
 * (query, url) and applies HAVING/WHERE pushdown; row reducer dedupes to the
 * best-positioned page per query (different semantics, kept for parity with
 * the existing live-GSC behavior).
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { QueryPageRow } from '../types'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { between, date as dateCol, gsc, page as pageCol, query as queryCol } from 'gscdump/query'
import { paginateClause, paginateInMemory } from '../analyzer/paginate'
import { createSorter } from '../types'

const DEFAULT_ROW_LIMIT = 25_000

export interface ZeroClickResult {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

const sortRowResults = createSorter<ZeroClickResult, 'impressions'>(
  item => item.impressions,
  'impressions',
)

export const zeroClickAnalyzer = defineAnalyzer<AnalysisParams, Row, ZeroClickResult[]>({
  id: 'zero-click',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 1000
    const maxCtr = params.maxCtr ?? 0.03
    const maxPosition = params.maxPosition ?? 10
    const limit = params.limit ?? 1000

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
        CAST(GREATEST(0, ROUND(impressions * (
          CASE
            WHEN position <= 1 THEN 0.30
            WHEN position <= 3 THEN 0.15
            WHEN position <= 5 THEN 0.08
            ELSE 0.04
          END
        )) - clicks) AS DOUBLE) AS missedClicks
      FROM agg
      WHERE position <= ? AND ctr < ?
      ORDER BY impressions DESC
      ${paginateClause({ limit, offset: params.offset })}
    `

    return {
      sql,
      params: [startDate, endDate, minImpressions, maxPosition, maxCtr],
      current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const minImpressions = params.minImpressions ?? 1000
    const maxCtr = params.maxCtr ?? 0.03
    const maxPosition = params.maxPosition ?? 10
    return {
      results: arr.map(r => ({
        query: r.query == null ? '' : String(r.query),
        page: r.page == null ? '' : String(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        missedClicks: num(r.missedClicks),
      } as unknown as ZeroClickResult)),
      meta: { total: arr.length, minImpressions, maxCtr, maxPosition },
    }
  },

  buildRows(params) {
    const period = periodOf(params)
    const limit = params.limit ?? DEFAULT_ROW_LIMIT
    return {
      rows: gsc.select(queryCol, pageCol).where(between(dateCol, period.startDate, period.endDate)).limit(limit).getState(),
    }
  },

  reduceRows(rows, params) {
    const arr = Array.isArray(rows) ? (rows as unknown as QueryPageRow[]) : []
    const minImpressions = params.minImpressions ?? 1000
    const maxCtr = params.maxCtr ?? 0.03
    const maxPosition = params.maxPosition ?? 10

    const queryMap = new Map<string, ZeroClickResult>()
    for (const row of arr) {
      if (row.impressions < minImpressions)
        continue
      if (row.position > maxPosition)
        continue
      if (row.ctr > maxCtr)
        continue
      const existing = queryMap.get(row.query)
      if (!existing || row.position < existing.position) {
        queryMap.set(row.query, {
          query: row.query,
          page: row.page,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        })
      }
    }
    const results = sortRowResults(Array.from(queryMap.values()), 'impressions', 'desc')
    const paged = paginateInMemory(results, { limit: params.limit, offset: params.offset })
    return { results: paged, meta: { total: results.length, returned: paged.length } }
  },
})
