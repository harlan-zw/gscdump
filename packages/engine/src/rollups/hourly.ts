import type { TenantCtx } from '@gscdump/contracts'
import type { SearchType } from 'gscdump/query'
import type { Row } from '../contracts'
import type { RollupEngine } from './core'

/**
 * Aggregate one day's `hourly_pages` partition into the daily `pages` shape
 * and write it to the daily Discover partition. After this runs for date D,
 * the daily query path serves D from `pages/.../daily/D` and the `hourly/D`
 * partition becomes read-only / GC-only.
 *
 * `(position - 1)` weighting matches the storage convention encoded by
 * `toSumPosition`: `sum_position = SUM((position - 1) * impressions)`, so a
 * downstream `SUM(sum_position) / SUM(impressions) + 1` recovers the mean.
 *
 * searchType-scoped: only call with `searchType: 'discover'`. The hourly
 * partition lives under `hourly_pages` and the output lands under `pages` so
 * existing dashboard queries (which read `pages`) see the rolled-up day
 * transparently.
 */
export interface RebuildDailyFromHourlyOptions {
  engine: RollupEngine & {
    writeDay: (scope: TenantCtx & { table: TableTypeName, date: string, searchType?: SearchType }, rows: Row[]) => Promise<void>
  }
  ctx: TenantCtx
  /** PT calendar day to roll up. */
  date: string
  searchType: 'discover'
}

// Local alias to avoid the cross-module type-only import collision.
type TableTypeName = import('@gscdump/contracts').TableName

export async function rebuildDailyFromHourly(opts: RebuildDailyFromHourlyOptions): Promise<{ rowsWritten: number }> {
  const { engine, ctx, date, searchType } = opts
  const result = await engine.runSQL({
    ctx,
    table: 'hourly_pages' as TableTypeName,
    fileSets: { FILES: { table: 'hourly_pages' as TableTypeName, partitions: [`hourly/${date}`] } },
    searchType,
    sql: `
      SELECT
        url,
        DATE '${date}' AS date,
        SUM(clicks)::BIGINT AS clicks,
        SUM(impressions)::BIGINT AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date = '${date}'
      GROUP BY url
    `,
  })
  const rows: Row[] = result.rows.map(r => ({
    url: r.url,
    date,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    sum_position: Number(r.sum_position),
  }))
  await engine.writeDay({
    userId: ctx.userId,
    siteId: ctx.siteId,
    table: 'pages' as TableTypeName,
    date,
    searchType,
  }, rows)
  return { rowsWritten: rows.length }
}
