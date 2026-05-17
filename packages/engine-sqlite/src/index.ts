/**
 * @gscdump/engine-sqlite — typed D1/SQLite analytics primitives.
 *
 * Mirror of @gscdump/engine-duckdb-wasm but dialect-targeted at sqlite-core. Use this when
 * analytics queries run against D1 (Cloudflare Workers) or any remote
 * sqlite surface accessible via an async executor (`sql, params) => rows`).
 */

export type { CachedManifestStore, CachedManifestStoreOptions } from './cached-manifest-store'
export { createCachedManifestStore } from './cached-manifest-store'
export { createEngine } from './engine'
export type { EngineConfig, SqliteQueryExecutor } from './engine'
export {
  aggClicks,
  aggCtr,
  aggImpressions,
  aggPosition,
} from './metrics'
// R2 manifest mirror tables + D1-backed ManifestStore implementation.
// Imported directly by host apps for drizzle-kit migration discovery.
export {
  r2Locks,
  r2Manifest,
  r2ShadowDiffs,
  r2SyncStates,
  r2Watermarks,
  r2WriteErrors,
} from './r2-manifest-schema'
export type {
  R2LockInsert,
  R2LockSelect,
  R2ManifestInsert,
  R2ManifestSelect,
  R2ShadowDiffInsert,
  R2ShadowDiffSelect,
  R2SyncStateInsert,
  R2SyncStateSelect,
  R2WatermarkInsert,
  R2WatermarkSelect,
  R2WriteErrorInsert,
  R2WriteErrorSelect,
} from './r2-manifest-schema'
export { createD1ManifestStore } from './r2-manifest-store'
export type { AnalyticsManifestDb } from './r2-manifest-store'
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

export { resolveWindow } from '@gscdump/engine/period'
export type {
  ComparisonMode,
  ResolvedWindow,
  ResolveWindowOptions,
  WindowPreset,
} from '@gscdump/engine/period'
export type { SQL } from 'drizzle-orm'
export { and, eq, gte, lte, sql } from 'drizzle-orm'
