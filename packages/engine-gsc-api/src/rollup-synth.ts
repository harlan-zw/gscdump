// Pure GSC-API → rollup-shape synthesisers. Used by nuxt-analytics free-tier
// endpoints to produce daily_totals / top_pages / top_keywords envelopes
// without any pre-built parquet. Lives in @gscdump/engine-gsc-api so the
// HTTP layer stays thin and other consumers (CLI live mode, MCP, future
// edge workers) can share one implementation.
//
// Design:
//  - No H3, no runtime config, no site-id encoding — pure functions over a
//    `GoogleSearchConsoleClient` + a fully-resolved `siteUrl`.
//  - `sum_position` is reconstructed as `position * impressions` so the
//    consumer's `sum_position / impressions` formula recovers the mean.
//  - Metric filter + ordering happens server-side on the GSC API where it
//    can; everything else trims after row collection.

import type { GoogleSearchConsoleClient } from 'gscdump'
import type { Column, Dimension, GSCQueryBuilder } from 'gscdump/query'
import { between, clicks as clicksCol, date as dateDim, gsc } from 'gscdump/query'

export async function collectRows<T>(gen: AsyncGenerator<T[]>): Promise<T[]> {
  const out: T[] = []
  for await (const batch of gen) out.push(...batch)
  return out
}

export interface GscRange {
  start: string
  end: string
}

export interface GscTopNRow {
  key: string
  clicks: number
  impressions: number
  sum_position: number
}

export interface FetchTopNOptions<D extends Dimension> {
  client: GoogleSearchConsoleClient
  siteUrl: string
  dimension: Column<D>
  range: GscRange
  /**
   * Ask the GSC API to order by clicks desc. Skip for dimensions where GSC
   * already returns sensibly ranked rows (e.g. country).
   */
  orderByClicksDesc?: boolean
  /** Forwarded to the GSC builder. */
  limit?: number
  /** Trim after the fact (e.g. country has no server-side limit). */
  sliceTop?: number
}

export async function fetchGscTopN<D extends Dimension>(
  opts: FetchTopNOptions<D>,
): Promise<GscTopNRow[]> {
  const { client, siteUrl, dimension, range, orderByClicksDesc, limit, sliceTop } = opts
  let builder = gsc.select(dimension).where(between(dateDim, range.start, range.end))
  if (orderByClicksDesc)
    builder = builder.orderBy(clicksCol, 'desc')
  if (typeof limit === 'number')
    builder = builder.limit(limit)

  const rows = await collectRows(
    client.query(siteUrl, builder as unknown as GSCQueryBuilder<never, never>),
  )
  const mapped = rows
    .map((r) => {
      const row = r as Record<string, unknown>
      const key = row[dimension.dimension]
      if (typeof key !== 'string' || !key)
        return null
      const impressions = Number(row.impressions ?? 0)
      const position = Number(row.position ?? 0)
      return {
        key,
        clicks: Number(row.clicks ?? 0),
        impressions,
        sum_position: position * impressions,
      }
    })
    .filter((x): x is GscTopNRow => x != null)

  if (!orderByClicksDesc)
    mapped.sort((a, b) => b.clicks - a.clicks)

  return typeof sliceTop === 'number' ? mapped.slice(0, sliceTop) : mapped
}

export interface GscDailyRow {
  date: number
  clicks: number
  impressions: number
  sum_position: number
  anonymizedImpressionsPct: number
}

export async function fetchGscDaily(opts: {
  client: GoogleSearchConsoleClient
  siteUrl: string
  range: GscRange
}): Promise<GscDailyRow[]> {
  const { client, siteUrl, range } = opts
  const builder = gsc
    .select(dateDim)
    .where(between(dateDim, range.start, range.end)) as unknown as GSCQueryBuilder<never, never>
  const rows = await collectRows(client.query(siteUrl, builder))
  return rows
    .map((r) => {
      const row = r as { date?: string, clicks?: number, impressions?: number, position?: number }
      if (!row.date)
        return null
      const impressions = row.impressions ?? 0
      return {
        date: Date.parse(`${row.date}T00:00:00Z`),
        clicks: row.clicks ?? 0,
        impressions,
        sum_position: (row.position ?? 0) * impressions,
        anonymizedImpressionsPct: 0,
      }
    })
    .filter((x): x is GscDailyRow => x != null)
    .sort((a, b) => a.date - b.date)
}
