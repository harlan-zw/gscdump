/**
 * @gscdump/engine-sqlite — typed D1/SQLite analytics primitives.
 *
 * Mirror of @gscdump/engine-wasm but dialect-targeted at sqlite-core. Use this when
 * analytics queries run against D1 (Cloudflare Workers) or any remote
 * sqlite surface accessible via an async executor (`sql, params) => rows`).
 */

export { createEngine } from './engine'
export type { EngineConfig, SqliteQueryExecutor } from './engine'
export {
  aggClicks,
  aggCtr,
  aggImpressions,
  aggPosition,
} from './metrics'
export {
  createSqliteResolverAdapter,
  createSqliteResolverAdapterFromExecutor,
  probeSqliteRegex,
  sqliteResolverAdapter,
} from './resolver-adapter'
export type { TableKey } from './resolver-adapter'
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
  gsc_countries,
  gsc_devices,
  gsc_keywords,
  gsc_page_keywords,
  gsc_pages,
  schema,
} from './schema'
export type { Schema } from './schema'
export { resolveWindow } from '@gscdump/analysis/period'
export type {
  ComparisonMode,
  ResolvedWindow,
  ResolveWindowOptions,
  WindowPreset,
} from '@gscdump/analysis/period'
export type { SQL } from 'drizzle-orm'
export { and, eq, gte, lte, sql } from 'drizzle-orm'
