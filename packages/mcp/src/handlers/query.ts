import type { z } from 'zod'
import type { customQueryInput, HandlerContext } from '../types'
import { between, country, date, device, gsc, page, query, searchAppearance } from 'gscdump/query'

const DIMENSION_MAP = {
  page,
  query,
  date,
  country,
  device,
  searchAppearance,
} as const

interface MetricsRow {
  clicks: number
  impressions: number
  ctr: number
  position: number
  [key: string]: unknown
}

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

  const rows: MetricsRow[] = []
  for await (const batch of ctx.client.query(input.siteUrl, builder)) {
    rows.push(...(batch as MetricsRow[]))
  }

  return { total: rows.length, data: rows }
}
