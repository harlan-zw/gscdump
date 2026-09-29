import type { GscdumpV1Client } from '@gscdump/sdk/v1'
import type { BuilderState, Filter } from 'gscdump/query'

/** The public v1 rows operation accepts at most this many rows per request. */
const PAGE_SIZE = 25_000

interface WireFilter {
  _filters: unknown[]
  _nestedGroups?: WireFilter[]
  _groupType?: 'and' | 'or'
}

/** The builder carries a type-only `_constraints` key. The v1 contract rejects unknown keys, so keep the wire fields only. */
function toWireFilter(filter: Filter<any>): WireFilter {
  const source = filter as unknown as WireFilter
  return {
    _filters: source._filters,
    ...(source._nestedGroups ? { _nestedGroups: source._nestedGroups.map(group => toWireFilter(group as unknown as Filter<any>)) } : {}),
    ...(source._groupType ? { _groupType: source._groupType } : {}),
  }
}

/**
 * Read rows from the hosted record through the public v1 `analytics.rows.query`
 * operation. It pages with `startRow` up to `state.rowLimit`. It never calls Google.
 */
export async function queryHostedRows(client: GscdumpV1Client, siteId: string, state: BuilderState): Promise<Record<string, unknown>[]> {
  const limit = state.rowLimit ?? PAGE_SIZE
  const rows: Record<string, unknown>[] = []
  while (rows.length < limit) {
    const rowLimit = Math.min(PAGE_SIZE, limit - rows.length)
    const body = {
      ...state,
      ...(state.filter ? { filter: toWireFilter(state.filter) } : {}),
      ...(state.prefilter ? { prefilter: toWireFilter(state.prefilter) } : {}),
      rowLimit,
      ...(rows.length > 0 ? { startRow: (state.startRow ?? 0) + rows.length } : {}),
    }
    const page = (await client.queryAnalyticsRows({ params: { siteId }, body: body as never })).data.rows
    rows.push(...page)
    if (page.length < rowLimit)
      break
  }
  return rows
}
