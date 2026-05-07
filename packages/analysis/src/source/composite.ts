// Composite analytics source: engine first, live GSC fallback for queries
// outside the site's synced window that the API can answer. The route
// decision lives behind a single predicate (`shouldRouteToLive`). SQL
// execution always routes to the engine (GSC API has no SQL surface).

import type { AnalysisQuerySource } from '@gscdump/engine/source'
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
 */
function shouldRouteToLive(state: BuilderState, site: SyncedRange): boolean {
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
  return {
    ...engine,
    name: 'composite-engine-live',
    async queryRows(state: BuilderState) {
      return shouldRouteToLive(state, site)
        ? live.queryRows(state)
        : engine.queryRows(state)
    },
  }
}
