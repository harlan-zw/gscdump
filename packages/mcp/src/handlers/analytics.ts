import type { Column, Dimension, GSCQueryBuilder } from 'gscdump/query'
import type { z } from 'zod'
import type { fetchAnalyticsInput, HandlerContext, MetricsRow } from '../types'
import { between, country, date, device, gsc, page, query } from 'gscdump/query'

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

async function fetchByDimension<D extends Dimension>(
  dimension: Column<D>,
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<{ total: number, data: MetricsRow[] }> {
  const builder = gsc
    .select(dimension, date)
    .where(between(date, input.period.start, input.period.end))
    .limit(25000)

  const rows = await collectRows(ctx, input.siteUrl, builder)
  return { total: rows.length, data: rows }
}

type FetchResult = Promise<{ total: number, data: MetricsRow[] }>

export function fetchPages(input: z.infer<typeof fetchAnalyticsInput>, ctx: HandlerContext): FetchResult {
  return fetchByDimension(page, input, ctx)
}

export function fetchKeywords(input: z.infer<typeof fetchAnalyticsInput>, ctx: HandlerContext): FetchResult {
  return fetchByDimension(query, input, ctx)
}

export function fetchCountries(input: z.infer<typeof fetchAnalyticsInput>, ctx: HandlerContext): FetchResult {
  return fetchByDimension(country, input, ctx)
}

export function fetchDevices(input: z.infer<typeof fetchAnalyticsInput>, ctx: HandlerContext): FetchResult {
  return fetchByDimension(device, input, ctx)
}
