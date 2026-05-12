// Composite analytics source: engine first, live GSC fallback for queries
// outside the site's synced window that the API can answer. The route
// decision lives behind a single predicate (`shouldRouteToLive`). SQL
// execution always routes to the engine (GSC API has no SQL surface).
//
// The seam reports `kind: 'composite'` and its own field shape — engine's
// fields are wired in explicitly rather than spread, so adding methods to
// engine doesn't silently change what the composite advertises. Planner
// capabilities are engine's: `shouldRouteToLive` gates live routing on
// `canProxyToGsc(state)`, which structurally rejects anything live can't
// honor, so the engine-side cap set is the truthful upper bound for any
// query the composite will accept.

import type { AnalysisQuerySource, ExecuteSqlOptions, QueryRow } from '@gscdump/engine/source'
import type { BuilderState } from 'gscdump/query'
import { canProxyToGsc } from '@gscdump/engine-gsc-api'
import { extractDateRange } from 'gscdump/query'

export interface SyncedRange {
  oldestDateSynced: string | null
  newestDateSynced: string | null
}

export interface CompositeSourceOptions {
  engine: AnalysisQuerySource
  live: AnalysisQuerySource
  site: SyncedRange
}

/**
 * Single predicate combining structural compatibility (`canProxyToGsc`) and
 * date-window coverage. Returns `true` when the query should be answered by
 * the live GSC API instead of the local engine: the API supports the query
 * shape AND the requested range falls outside (or is partially outside) the
 * synced window. Sites with no synced data route everything live.
 *
 * Exported so callers (telemetry, debug UIs) can introspect the routing
 * decision without re-implementing it.
 */
export function shouldRouteToLive(state: BuilderState, site: SyncedRange): boolean {
  if (!canProxyToGsc(state))
    return false
  const { startDate, endDate } = extractDateRange(state.filter)
  if (!startDate || !endDate)
    return false
  if (!site.oldestDateSynced || !site.newestDateSynced)
    return true
  return startDate < site.oldestDateSynced || endDate > site.newestDateSynced
}

export function createCompositeSource(opts: CompositeSourceOptions): AnalysisQuerySource {
  const { engine, live, site } = opts
  const engineExecuteSql = engine.executeSql
  return {
    name: 'composite-engine-live',
    kind: 'composite',
    capabilities: engine.capabilities,
    adapter: engine.adapter,
    siteId: engine.siteId,
    async queryRows(state: BuilderState): Promise<QueryRow[]> {
      return shouldRouteToLive(state, site)
        ? live.queryRows(state)
        : engine.queryRows(state)
    },
    executeSql: engineExecuteSql
      ? (sql: string, params?: unknown[], execOpts?: ExecuteSqlOptions) =>
          engineExecuteSql(sql, params, execOpts)
      : undefined,
  }
}
