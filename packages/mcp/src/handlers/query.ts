import type { GscDataRow } from 'gscdump'
import type { z } from 'zod'
import type { customQueryInput, HandlerContext } from '../types'
import { createQueryBody, queryRecursive } from 'gscdump'
import { toPeriod } from '../types'

export async function customQuery(
  input: z.infer<typeof customQueryInput>,
  ctx: HandlerContext,
): Promise<{ data: { rows: GscDataRow[] }, pages: number }> {
  const period = toPeriod(input.period)
  const body = createQueryBody({
    period,
    ...input.options,
  })

  return queryRecursive(ctx.auth, input.siteUrl, {
    ...body,
    dimensions: input.dimensions,
    rowLimit: input.rowLimit || 25_000,
  })
}
