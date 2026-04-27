// Composite analytics source: engine first, live GSC fallback for queries
// whose date range falls outside the site's synced window AND can be
// answered by GSC's native API (no metric filters, no engine-derived dimensions).
//
// SQL execution always routes to the engine (GSC API has no SQL surface).

import type { AnalysisQuerySource, SqlQuerySource } from '@gscdump/analysis'
import type { BuilderState } from 'gscdump/query'
import { extractDateRange } from 'gscdump/query'
import { canProxyToGsc } from './live-source'

export interface CompositeSourceOptions {
  engine: SqlQuerySource
  live: AnalysisQuerySource
  site: { oldestDateSynced: string | null, newestDateSynced: string | null }
}

export function createCompositeSource(opts: CompositeSourceOptions): SqlQuerySource {
  const { engine, live, site } = opts

  function rangeCovered(state: BuilderState): boolean {
    const { startDate, endDate } = extractDateRange(state.filter)
    return !!(
      startDate
      && endDate
      && site.oldestDateSynced
      && site.newestDateSynced
      && startDate >= site.oldestDateSynced
      && endDate <= site.newestDateSynced
    )
  }

  return {
    name: 'composite-engine-live',
    capabilities: engine.capabilities,
    async queryRows(state: BuilderState) {
      if (!rangeCovered(state) && canProxyToGsc(state))
        return live.queryRows(state)
      return engine.queryRows(state)
    },
    executeSql: engine.executeSql,
  }
}
