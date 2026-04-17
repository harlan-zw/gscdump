/**
 * @gscdump/analysis/query — dialect-neutral SQL composers for `BuilderState`.
 *
 * Pass a {@link ResolverAdapter} from either `@gscdump/analysis/sqlite`
 * (site D1, `site_id` scoped) or `@gscdump/analysis/browser` (parquet, single
 * tenant). Composers stay identical; only the table/column bindings and the
 * dialect compilation differ.
 */

export {
  buildExtrasQueries,
  buildTotalsSql,
  mergeExtras,
  resolveComparisonSQL,
  resolveToSQL,
  resolveToSQLOptimized,
} from './resolver'

export type {
  ComparisonFilter,
  ExtraQuery,
  ResolvedComparisonSQL,
  ResolvedSQL,
  ResolvedSQLOptimized,
  ResolverAdapter,
  ResolverOptions,
} from './types'
