// Bridges resolver extras (`buildExtrasQueries` keys) to materialised rollups.
// Engine owns the key→rollup-id mapping; the host supplies the actual rollup
// read (storage/tenant routing stays in the effectful shell). See ADR-0017.

import type { SearchType } from '../storage'
import type { ResolveExtraFn, RunQueryCtx } from './run-query'

/**
 * Resolver extra `key` → materialised rollup `id`. Extend as more read-time
 * aggregates get rollup-backed. A key absent here has no rollup overlay, so the
 * resolver always runs its live SQL for it.
 */
const EXTRA_ROLLUP_IDS: Readonly<Record<string, string>> = {
  // `buildExtrasQueries` emits `canonicalExtras`; `queryCanonicalVariantsRollup`
  // materialises the same columns (joinKey/variantCount/canonicalName/variants).
  canonicalExtras: 'query_canonical_variants',
}

/**
 * Host-supplied reader: return the materialised rollup's rows for an
 * `(id, tenant, slice)`, in the exact shape the live extra produces, or `null`
 * when no rollup exists (first sync, never built, stale) so the overlay
 * declines and the resolver falls back to the live query. Typically wired with
 * `readLatestRollup` + a `read_parquet` of the pointer.
 *
 * `dateRange` is the request window. `query_canonical_variants` is full-history
 * (its grouping/variant metrics span all dates), but `buildExtrasQueries`
 * windows the live `canonicalExtras` to the requested range — so for a narrow
 * window the reader MUST decline (return `null`) rather than attach
 * out-of-window variantCount/canonicalName/variants. A common rule: serve only
 * when the request window covers full history.
 */
export interface RollupRowsReader {
  (opts: {
    id: string
    ctx: { userId: string, siteId: string }
    searchType?: SearchType
    dateRange: { startDate: string, endDate: string }
  }): Promise<Array<Record<string, unknown>> | null>
}

/**
 * Build a {@link ResolveExtraFn} that serves resolver extras from materialised
 * rollups when one is mapped for the extra's key, else returns `null` to fall
 * back to the live SQL. Pure wiring around the host's `readRollupRows`.
 */
export function createRollupExtrasOverlay(readRollupRows: RollupRowsReader): ResolveExtraFn {
  return async ({ key, ctx, dateRange }: { key: string, ctx: RunQueryCtx, dateRange: { startDate: string, endDate: string } }) => {
    const id = EXTRA_ROLLUP_IDS[key]
    if (id === undefined)
      return null
    return readRollupRows({
      id,
      ctx: { userId: ctx.userId, siteId: ctx.siteId },
      dateRange,
      ...(ctx.searchType !== undefined ? { searchType: ctx.searchType } : {}),
    })
  }
}
