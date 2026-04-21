import type { Dimension, GSCQueryBuilder } from 'gscdump/query'
import type { z } from 'zod'
import type { fetchAnalyticsInput, HandlerContext } from '../types'
import { between, country, date, device, gsc, page, query } from 'gscdump/query'

interface MetricsRow {
  clicks: number
  impressions: number
  ctr: number
  position: number
  [key: string]: unknown
}

async function collectRows<T extends MetricsRow, D extends Dimension[], C>(
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

export async function fetchPages(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<{ total: number, data: MetricsRow[] }> {
  const builder = gsc
    .select(page, date)
    .where(between(date, input.period.start, input.period.end))
    .limit(25000)

  const rows = await collectRows(ctx, input.siteUrl, builder)
  return { total: rows.length, data: rows }
}

export async function fetchKeywords(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<{ total: number, data: MetricsRow[] }> {
  const builder = gsc
    .select(query, date)
    .where(between(date, input.period.start, input.period.end))
    .limit(25000)

  const rows = await collectRows(ctx, input.siteUrl, builder)
  return { total: rows.length, data: rows }
}

export async function fetchCountries(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<{ total: number, data: MetricsRow[] }> {
  const builder = gsc
    .select(country, date)
    .where(between(date, input.period.start, input.period.end))
    .limit(25000)

  const rows = await collectRows(ctx, input.siteUrl, builder)
  return { total: rows.length, data: rows }
}

export async function fetchDevices(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<{ total: number, data: MetricsRow[] }> {
  const builder = gsc
    .select(device, date)
    .where(between(date, input.period.start, input.period.end))
    .limit(25000)

  const rows = await collectRows(ctx, input.siteUrl, builder)
  return { total: rows.length, data: rows }
}
