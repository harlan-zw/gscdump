/**
 * @gscdump/analysis/query — query analyzer plan builders.
 *
 * Dialect-neutral SQL composition primitives now live in
 * `@gscdump/engine/resolver` (re-exported by `@gscdump/engine-wasm` /
 * `@gscdump/engine-sqlite`). This module narrowly exposes the data-query
 * / data-detail analyzer plans that `@gscdump/analysis` owns.
 */

export {
  buildDataDetailPlan,
  buildDataQueryPlan,
} from './analyzers'
export type { QueryAnalyzerExtraQuery, QueryAnalyzerPlan } from './analyzers'
export { normalizeQuery } from './normalize'
