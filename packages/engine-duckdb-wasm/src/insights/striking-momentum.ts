/**
 * Striking Distance Momentum — validates the drizzle surface against the
 * exact insight the benchmark sub-agent hand-wrote in raw SQL.
 *
 * For every (query, url) pair in page_queries, split the trailing 180 days
 * around `anchor` into two 90-day windows. Compute impression-weighted avg
 * position per window, keep queries with prior-period baseline
 * (`prior_impr >= 10`) and recent signal (`recent_impr >= 50`), then rank
 * by a momentum score `(prior_pos - recent_pos) * ln(recent_impr + 1)`
 * with a 1.5x multiplier when current rank is in the 8-20 striking-distance
 * band.
 *
 * Uses drizzle's sql template for the window/CTE/weighted-aggregation
 * math. The typed schema gives column-name safety; the sql template gives
 * DuckDB-specific math surface (LN, GREATEST, etc.) that the high-level
 * builder doesn't cleanly express.
 */

import type { InsightRunner } from '../runner'

import { sql } from 'drizzle-orm'
import { toIsoDate } from 'gscdump/dates'

import { page_queries } from '../schema'

export interface StrikingMomentumOptions {
  /** Anchor date (YYYY-MM-DD). Defaults to today. */
  anchor?: string
  /** Width of each window in days. Default 90. */
  windowDays?: number
  /** Minimum impressions in the prior window for a row to qualify. Default 10. */
  minPriorImpressions?: number
  /** Minimum impressions in the recent window. Default 50. */
  minRecentImpressions?: number
  /** Result limit. Default 20. */
  limit?: number
}

export interface StrikingMomentumRow {
  query: string
  url: string
  recent_impr: number
  recent_pos: number
  prior_impr: number
  prior_pos: number
  momentum_score: number
}

export async function strikingMomentum(
  runner: InsightRunner,
  opts: StrikingMomentumOptions = {},
): Promise<StrikingMomentumRow[]> {
  const windowDays = opts.windowDays ?? 90
  const anchor = opts.anchor ?? toIsoDate(new Date())
  const minPrior = opts.minPriorImpressions ?? 10
  const minRecent = opts.minRecentImpressions ?? 50
  const limit = opts.limit ?? 20

  const windowExpr = sql`
    WITH pk AS (
      SELECT
        query,
        url,
        ${page_queries.date} AS date,
        ${page_queries.impressions} AS impressions,
        ${page_queries.sum_position} AS sum_position,
        CASE
          WHEN ${page_queries.date} >= (DATE ${sql.raw(`'${anchor}'`)} - INTERVAL ${sql.raw(`${windowDays}`)} DAY)
          THEN 'recent' ELSE 'prior'
        END AS period
      FROM ${page_queries}
      WHERE ${page_queries.date} >= (DATE ${sql.raw(`'${anchor}'`)} - INTERVAL ${sql.raw(`${windowDays * 2}`)} DAY)
        AND ${page_queries.date} <  (DATE ${sql.raw(`'${anchor}'`)} + INTERVAL 1 DAY)
    ),
    agg AS (
      SELECT
        query, url, period,
        SUM(impressions) AS impr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS weighted_pos
      FROM pk
      GROUP BY query, url, period
    ),
    paired AS (
      SELECT
        query, url,
        MAX(CASE WHEN period = 'recent' THEN impr END) AS recent_impr,
        MAX(CASE WHEN period = 'recent' THEN weighted_pos END) AS recent_pos,
        MAX(CASE WHEN period = 'prior' THEN impr END) AS prior_impr,
        MAX(CASE WHEN period = 'prior' THEN weighted_pos END) AS prior_pos
      FROM agg
      GROUP BY query, url
    ),
    best AS (
      SELECT
        query, url, recent_impr, recent_pos, prior_impr, prior_pos,
        ROW_NUMBER() OVER (PARTITION BY query ORDER BY recent_impr DESC NULLS LAST) AS rn
      FROM paired
      WHERE prior_impr >= ${minPrior} AND recent_impr >= ${minRecent}
    )
    SELECT
      query, url,
      recent_impr, recent_pos, prior_impr, prior_pos,
      (prior_pos - recent_pos)
        * LN(recent_impr + 1)
        * CASE WHEN recent_pos BETWEEN 8 AND 20 THEN 1.5 ELSE 1.0 END
      AS momentum_score
    FROM best
    WHERE rn = 1
    ORDER BY momentum_score DESC NULLS LAST
    LIMIT ${limit}
  `

  const rows = await runner.db.execute(windowExpr)
  return rows as unknown as StrikingMomentumRow[]
}
