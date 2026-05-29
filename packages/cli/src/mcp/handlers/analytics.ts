/**
 * Shared row-collection helper. The previous fetch-pages / fetch-keywords /
 * fetch-countries / fetch-devices handlers were removed in favour of
 * `run-report`; agents that want raw rows should call the `query` tool
 * directly with explicit dimensions and filters.
 */

import type { Dimension, GSCQueryBuilder } from 'gscdump/query'
import type { HandlerContext, MetricsRow } from '../types'

export async function collectRows<T extends MetricsRow, D extends Dimension[], C>(
  ctx: HandlerContext,
  siteUrl: string,
  builder: GSCQueryBuilder<D, C>,
): Promise<T[]> {
  const rows: T[] = []
  for await (const batch of ctx.client.query(siteUrl, builder)) {
    rows.push(...(batch as T[]))
  }
  return rows
}
