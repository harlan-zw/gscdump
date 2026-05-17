/**
 * `@gscdump/engine-gsc-api` — wraps the Google Search Console live REST API
 * as an `AnalysisQuerySource` for typed analyzer dispatch. Pair with
 * `@gscdump/engine/source` for engine-backed parquet reads, or with
 * `createCompositeSource` from `@gscdump/analysis` to fall back to GSC for
 * date ranges outside the synced window.
 */

export { canProxyToGsc, createLiveGscSource } from './live'
export type { CreateLiveGscSourceOptions } from './live'
export {
  fetchGscDaily,
  fetchGscTopN,
} from './rollup-synth'
export type {
  FetchTopNOptions,
  GscDailyRow,
  GscRange,
  GscTopNRow,
} from './rollup-synth'
export { createGscApiQuerySource } from './source'
export type { GscApiQuerySourceOptions } from './source'
export type {
  GscApiRow,
  RunGscSyncSliceOptions,
  RunGscSyncSliceResult,
  SyncSliceDomainFilter,
} from './sync-slice'
export { runGscSyncSlice } from './sync-slice'
