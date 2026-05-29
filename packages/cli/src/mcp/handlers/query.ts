import type { z } from 'zod'
import type { customQueryInput, HandlerContext, MetricsRow } from '../types'
import { between, country, date, device, gsc, page, query, searchAppearance } from 'gscdump/query'
import { collectRows } from './analytics'

const DIMENSION_MAP = {
  page,
  query,
  date,
  country,
  device,
  searchAppearance,
} as const

export async function customQuery(
  input: z.infer<typeof customQueryInput>,
  ctx: HandlerContext,
): Promise<{ total: number, data: MetricsRow[] }> {
  const dimensions = input.dimensions
    .filter(d => d in DIMENSION_MAP)
    .map(d => DIMENSION_MAP[d])

  if (dimensions.length === 0) {
    throw new Error('At least one valid dimension required')
  }

  const builder = gsc
    .select(...dimensions)
    .where(between(date, input.period.start, input.period.end))
    .limit(input.rowLimit || 25000)

  const rows = await collectRows<MetricsRow, any, any>(ctx, input.siteUrl, builder)

  return { total: rows.length, data: rows }
}
