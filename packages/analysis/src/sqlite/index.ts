/**
 * @gscdump/analysis/sqlite — typed D1/SQLite analytics primitives.
 *
 * Mirror of /browser but dialect-targeted at sqlite-core. Use this when
 * analytics queries run against D1 (Cloudflare Workers) or any remote
 * sqlite surface accessible via an async executor (`sql, params) => rows`.
 *
 * - createSqliteInsightRunner({ executor }) wraps drizzle's sqlite-proxy
 *   adapter so typed .select() / window-fn queries compile and execute
 *   against the live DB without hand-rolled SQL strings.
 * - resolveWindow / scopeFor / mergeScope behave identically to /browser.
 * - `schema` mirrors the live D1 tables (`gsc_pages`, `gsc_keywords`,
 *   ...). Every table has `site_id` so scopeFor emits the predicate.
 *
 * For pure query compilation (no execution), use the schema + drizzle's
 * `.toSQL()` directly — the runner's executor is only needed for
 * round-trip calls.
 */

export { resolveWindow } from '../window'
export type {
  ComparisonMode,
  ResolvedWindow,
  ResolveWindowOptions,
  WindowPreset,
} from '../window'
export {
  aggClicks,
  aggCtr,
  aggImpressions,
  aggPosition,
} from './metrics'
export { sqliteResolverAdapter } from './resolver-adapter'
export {
  compileSqlite,
  createSqliteInsightRunner,
  mergeScope,
  scopeFor,
} from './runner'
export type {
  ScopedRunnerOptions,
  SqliteInsightRunner,
  SqliteInsightRunnerOptions,
  SqliteRowExecutor,
  TableScope,
} from './runner'
export {
  colRef,
  dateColRef,
  DIM_COLUMN_MAP,
  dimColumn,
  dimensionPredicates,
  dimExprSql,
  havingPredicates,
  inferTable,
  isMetricDimension,
  METRIC_NAMES,
  metricSql,
  siteIdColRef,
  tableRef,
  topLevelPredicate,
  urlToPathExpr,
} from './runtime-builder'
export type { TableKey } from './runtime-builder'
export {
  gsc_countries,
  gsc_devices,
  gsc_keywords,
  gsc_page_keywords,
  gsc_pages,
  schema,
} from './schema'
export type { Schema } from './schema'
export type { SQL } from 'drizzle-orm'
export { and, eq, gte, lte, sql } from 'drizzle-orm'
