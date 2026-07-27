import type { RollupDef } from './core'
import { utcDateMinusDays } from './dates'
import { partitionsInRange, runWindowed } from './windows'

// ---------------------------------------------------------------------------
// Default rollup definitions
// ---------------------------------------------------------------------------

/**
 * Daily totals across the full history. One row per (date, table) with
 * clicks + impressions + position. Powers sparklines and headline totals.
 *
 * Includes `anonymizedImpressionsPct` per day computed as
 *   1 - sum(query_grained_impressions) / sum(page_grained_impressions)
 * — surfaces GSC's anonymous-query gap so the dashboard can warn users not
 * to trust query-grained breakdowns as comprehensive.
 */
export const dailyTotalsRollup: RollupDef = {
  id: 'daily_totals',
  windowDays: null,
  async build({ engine, ctx, searchType }) {
    const pageRows = await runWindowed({
      engine,
      ctx,
      table: 'pages',
      ...(searchType !== undefined ? { searchType } : {}),
      sqlFor: w => `
        SELECT
          date,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${w.start}' AND date <= '${w.end}'
        GROUP BY date
        ORDER BY date
      `,
    })
    const queryRows = await runWindowed({
      engine,
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
      sqlFor: w => `
        SELECT
          date,
          SUM(impressions)::BIGINT AS impressions
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${w.start}' AND date <= '${w.end}'
        GROUP BY date
      `,
    })
    // Windows are date-disjoint, but merge defensively by date in case a tier
    // file straddling a boundary slipped a date through twice.
    const pagesByDate = new Map<string, { date: string, clicks: bigint, impressions: bigint, sum_position: number }>()
    for (const r of pageRows) {
      const date = String(r.date)
      const cur = pagesByDate.get(date) ?? { date, clicks: BigInt(0), impressions: BigInt(0), sum_position: 0 }
      cur.clicks += BigInt(r.clicks as bigint | number)
      cur.impressions += BigInt(r.impressions as bigint | number)
      cur.sum_position += Number(r.sum_position)
      pagesByDate.set(date, cur)
    }
    const queryImpressionsByDate = new Map<string, bigint>()
    for (const r of queryRows) {
      const date = String(r.date)
      queryImpressionsByDate.set(
        date,
        (queryImpressionsByDate.get(date) ?? BigInt(0)) + BigInt(r.impressions as bigint | number),
      )
    }
    return Array.from(pagesByDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => {
      const totalImpressions = BigInt(r.impressions as bigint | number)
      const queryImpressions = queryImpressionsByDate.get(String(r.date)) ?? BigInt(0)
      const anonymized = totalImpressions === BigInt(0)
        ? 0
        : 1 - Number(queryImpressions) / Number(totalImpressions)
      return {
        date: r.date,
        clicks: Number(r.clicks),
        impressions: Number(r.impressions),
        sum_position: Number(r.sum_position),
        anonymizedImpressionsPct: Math.max(0, Math.min(1, anonymized)),
      }
    })
  },
}

/** Weekly totals, ISO week aligned. Cheap and stable for trend widgets. */
export const weeklyTotalsRollup: RollupDef = {
  id: 'weekly_totals',
  windowDays: null,
  async build({ engine, ctx, searchType }) {
    const rows = await runWindowed({
      engine,
      ctx,
      table: 'pages',
      ...(searchType !== undefined ? { searchType } : {}),
      sqlFor: w => `
        SELECT
          strftime(date_trunc('week', date::DATE), '%Y-%m-%d') AS week,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${w.start}' AND date <= '${w.end}'
        GROUP BY 1
        ORDER BY 1
      `,
    })
    // A calendar week can straddle a window boundary, so the same `week`
    // appears in two adjacent windows. Merge by week, summing every metric.
    const byWeek = new Map<string, { week: string, clicks: number, impressions: number, sum_position: number }>()
    for (const r of rows) {
      const week = String(r.week)
      const cur = byWeek.get(week) ?? { week, clicks: 0, impressions: 0, sum_position: 0 }
      cur.clicks += Number(r.clicks)
      cur.impressions += Number(r.impressions)
      cur.sum_position += Number(r.sum_position)
      byWeek.set(week, cur)
    }
    return Array.from(byWeek.values()).sort((a, b) => (a.week < b.week ? -1 : 1))
  },
}

/**
 * Top 1000 pages by clicks over the trailing 28-day window. JSON for v1;
 * promote to parquet (`top_pages_28d.parquet`) when the dashboard needs
 * server-side WHERE filtering on this rollup.
 */
export const topPages28dRollup: RollupDef = {
  id: 'top_pages_28d',
  windowDays: 28,
  async build({ engine, ctx, windowAnchorMs, searchType }) {
    const cutoff = utcDateMinusDays(windowAnchorMs, 28)
    const parts = await engine.listPartitions({
      ctx,
      table: 'pages',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const partitions = partitionsInRange(parts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    if (partitions.length === 0)
      return []
    const result = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { FILES: { table: 'pages', partitions } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          url,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${cutoff}'
        GROUP BY url
        ORDER BY clicks DESC
        LIMIT 1000
      `,
    })
    return result.rows.map(r => ({
      url: r.url,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      sum_position: Number(r.sum_position),
    }))
  },
}

/**
 * Top 250 countries by clicks over the trailing 28-day window. Countries
 * cardinality is bounded (~250 ISO codes), so the list fits in a tiny JSON
 * payload regardless of traffic shape. Powers a geo-overview widget without
 * spinning up DuckDB-WASM.
 */
export const topCountries28dRollup: RollupDef = {
  id: 'top_countries_28d',
  windowDays: 28,
  async build({ engine, ctx, windowAnchorMs, searchType }) {
    const cutoff = utcDateMinusDays(windowAnchorMs, 28)
    const parts = await engine.listPartitions({
      ctx,
      table: 'countries',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const partitions = partitionsInRange(parts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    if (partitions.length === 0)
      return []
    const result = await engine.runSQL({
      ctx,
      table: 'countries',
      fileSets: { FILES: { table: 'countries', partitions } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          country,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${cutoff}'
        GROUP BY country
        ORDER BY clicks DESC
        LIMIT 250
      `,
    })
    return result.rows.map(r => ({
      country: r.country,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      sum_position: Number(r.sum_position),
    }))
  },
}

/** Top 1000 keywords by clicks over the trailing 28-day window. */
export const topKeywords28dRollup: RollupDef = {
  id: 'top_keywords_28d',
  windowDays: 28,
  async build({ engine, ctx, windowAnchorMs, searchType }) {
    const cutoff = utcDateMinusDays(windowAnchorMs, 28)
    const parts = await engine.listPartitions({
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const partitions = partitionsInRange(parts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    if (partitions.length === 0)
      return []
    const result = await engine.runSQL({
      ctx,
      table: 'queries',
      fileSets: { FILES: { table: 'queries', partitions } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          query,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${cutoff}'
        GROUP BY query
        ORDER BY clicks DESC
        LIMIT 1000
      `,
    })
    return result.rows.map(r => ({
      query: r.query,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      sum_position: Number(r.sum_position),
    }))
  },
}

/**
 * Parquet-format companion to `topKeywords28dRollup`. Same shape, but persists
 * as a parquet object plus JSON sidecar pointer so widgets that need
 * server-side WHERE (filter by prefix, by clicks threshold, paginate) can scan
 * it directly with DuckDB-WASM instead of loading all 1000 rows into JS.
 *
 * Opt-in: include in the caller's rollup def list alongside (or instead of)
 * the JSON variant; the runner treats the two as independent ids so they can
 * coexist during a migration.
 */
export const topKeywords28dParquetRollup: RollupDef = {
  id: 'top_keywords_28d_parquet',
  windowDays: 28,
  format: 'parquet',
  parquetColumns: [
    { name: 'query', type: 'VARCHAR', nullable: false },
    { name: 'clicks', type: 'BIGINT', nullable: false },
    { name: 'impressions', type: 'BIGINT', nullable: false },
    { name: 'sum_position', type: 'DOUBLE', nullable: false },
  ],
  parquetSortKey: ['clicks'],
  async build({ engine, ctx, windowAnchorMs, searchType }) {
    const cutoff = utcDateMinusDays(windowAnchorMs, 28)
    const parts = await engine.listPartitions({
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const partitions = partitionsInRange(parts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    if (partitions.length === 0)
      return []
    const result = await engine.runSQL({
      ctx,
      table: 'queries',
      fileSets: { FILES: { table: 'queries', partitions } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          query,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${cutoff}'
        GROUP BY query
        ORDER BY clicks DESC
        LIMIT 1000
      `,
    })
    return result.rows.map(r => ({
      query: String(r.query),
      clicks: BigInt(r.clicks as bigint | number),
      impressions: BigInt(r.impressions as bigint | number),
      sum_position: Number(r.sum_position),
    }))
  },
}
