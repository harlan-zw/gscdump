import type { Result } from 'gscdump/result'
import type { z } from 'zod'
import type { McpHandlerError } from '../errors'
import type { customQueryInput, HandlerContext, MetricsRow } from '../types'
import { between, country, date, device, gsc, page, query, searchAppearance } from 'gscdump/query'
import { err, ok, unwrapResult } from 'gscdump/result'
import { enrichToolError, mcpHandlerErrors, mcpHandlerErrorToException } from '../errors'
import { collectRows } from './analytics'

const DIMENSION_MAP = {
  page,
  query,
  date,
  country,
  device,
  searchAppearance,
} as const

/**
 * Errors-as-values core for {@link customQuery}: the only request-boundary
 * mistake an agent can make (every requested dimension was unknown) returns a
 * typed `McpHandlerError`. The query builder's own modelled failures
 * (`QueryError`) propagate as defects here; the throwing wrapper rewrites them.
 */
export async function customQueryResult(
  input: z.infer<typeof customQueryInput>,
  ctx: HandlerContext,
): Promise<Result<{ total: number, data: MetricsRow[] }, McpHandlerError>> {
  const dimensions = input.dimensions
    .filter(d => d in DIMENSION_MAP)
    .map(d => DIMENSION_MAP[d])

  if (dimensions.length === 0)
    return err(mcpHandlerErrors.noValidDimension())

  const builder = gsc
    .select(...dimensions)
    .where(between(date, input.period.start, input.period.end))
    .limit(input.rowLimit || 25000)

  const rows = await collectRows<MetricsRow, any, any>(ctx, input.siteUrl, builder)

  return ok({ total: rows.length, data: rows })
}

/**
 * MCP `query` handler. Thin throwing wrapper over {@link customQueryResult}:
 * collapses the typed boundary error to a throw and rewrites an upstream
 * `QueryError` (e.g. `unresolvable-dataset`) into a `[query:kind]` payload.
 */
export async function customQuery(
  input: z.infer<typeof customQueryInput>,
  ctx: HandlerContext,
): Promise<{ total: number, data: MetricsRow[] }> {
  return unwrapResult(
    await customQueryResult(input, ctx).catch((thrown: unknown) => {
      throw enrichToolError(thrown) ?? thrown
    }),
    mcpHandlerErrorToException,
  )
}
