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
import { isStateResolvable } from 'gscdump/query/plan'

export interface SyncedRange {
  oldestDateSynced: string | null
  newestDateSynced: string | null
  /**
   * Optional sorted list of `[start, end]` daily-key spans (`YYYY-MM-DD`,
   * both inclusive) that the engine actually has partitions for. When set,
   * `shouldRouteToLive` returns true for any requested range that overlaps
   * a day NOT inside one of these spans — even when the request sits inside
   * `oldestDateSynced..newestDateSynced`. Lets the composite catch *internal*
   * manifest gaps (e.g. a missing monthly tier) that the outer envelope
   * doesn't reveal. Spans must be sorted by `start` and non-overlapping.
   */
  coveredSpans?: ReadonlyArray<{ start: string, end: string }>
}

export interface CompositeSourceOptions {
  engine: AnalysisQuerySource
  live: AnalysisQuerySource
  site: SyncedRange
}

/**
 * Returns true when `[start, end]` (inclusive, ISO daily keys) is NOT fully
 * covered by `coveredSpans` (sorted, non-overlapping `[start, end]` spans).
 * O(spans.length). Exported for diagnostics.
 */
export function hasGapInCoveredSpans(
  start: string,
  end: string,
  coveredSpans: ReadonlyArray<{ start: string, end: string }>,
): boolean {
  let cursor = start
  for (const span of coveredSpans) {
    if (span.end < cursor)
      continue
    if (span.start > cursor)
      return true
    if (span.end >= end)
      return false
    cursor = nextDay(span.end)
    if (cursor > end)
      return false
  }
  return cursor <= end
}

function nextDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`) + 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * Single predicate combining structural compatibility (`canProxyToGsc`),
 * cross-dimension resolvability, and date-window coverage. Returns `true`
 * when the query should be answered by the live GSC API instead of the local
 * engine: the API supports the query shape AND (the query is cross-dimension
 * so no stored table can answer it OR the requested range falls outside the
 * synced envelope OR overlaps an internal manifest gap when `coveredSpans` is
 * provided). Sites with no synced data route everything live.
 *
 * Exported so callers (telemetry, debug UIs) can introspect the routing
 * decision without re-implementing it.
 */
export function shouldRouteToLive(state: BuilderState, site: SyncedRange): boolean {
  if (!canProxyToGsc(state))
    return false
  // Cross-dimension queries (grouped + filtered dimensions spanning two
  // stored datasets, e.g. a `query` breakdown filtered by `device`) have no
  // stored per-dimension table that carries every referenced column. Only the
  // live GSC API computes them — route there regardless of sync coverage.
  if (!isStateResolvable(state))
    return true
  const { startDate, endDate } = extractDateRange(state.filter)
  if (!startDate || !endDate)
    return false
  if (!site.oldestDateSynced || !site.newestDateSynced)
    return true
  if (startDate < site.oldestDateSynced || endDate > site.newestDateSynced)
    return true
  if (site.coveredSpans && site.coveredSpans.length > 0)
    return hasGapInCoveredSpans(startDate, endDate, site.coveredSpans)
  return false
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
