/**
 * @gscdump/engine-duckdb-wasm — typed DuckDB-WASM analytics primitives.
 *
 * Three primitives that upstream consumers (gscdump.com, custom dashboards)
 * compose together:
 *
 * - createInsightRunner({ db, conn }): a drizzle-orm handle bound to an
 *   AsyncDuckDBConnection. Use it for typed .select() / .with() / window
 *   functions against the known schema, or drop to raw SQL via the `raw`
 *   tagged template helper.
 * - resolveWindow({ preset, comparison }): canonical date windows, including
 *   prev-period and yoy comparison ranges. No more per-analyzer date math.
 * - scopeFor(table, { siteId, window }): boundary predicates for
 *   multi-tenant queries so consumers never forget to scope.
 *
 * Typed queries run against a drizzle schema mirroring gscdump/analytics
 * SCHEMAS. Drift between the two fails loudly at module load.
 *
 * Underneath: a vendored, stripped-down drizzle-orm DuckDB-WASM adapter
 * (adapted from @proj-airi/drizzle-duckdb-wasm, MIT). Small enough to own;
 * no external bus-factor risk on a load-bearing primitive.
 */

export { compileArchetypeSql, tableForArchetype } from './archetype-sql'
export type { CompiledArchetypeSql } from './archetype-sql'
export { createClient } from './drizzle-adapter'
export type { DuckDBWasmClient } from './drizzle-adapter'
export { drizzle, DuckDBWasmDatabase } from './drizzle-adapter'
export type { DuckDBWasmDrizzleDatabase } from './drizzle-adapter'
export { strikingMomentum } from './insights/striking-momentum'
export type { StrikingMomentumOptions, StrikingMomentumRow } from './insights/striking-momentum'
export {
  attachOpfsParquetTables,
  clearOpfsSnapshotCache,
  estimateOpfsStorage,
  OpfsQuotaExceededError,
  readOpfsSnapshotFile,
  requestPersistentStorage,
} from './opfs'
export type {
  AttachOpfsTablesOptions,
  OpfsAttachedHandle,
  OpfsFileProgress,
  OpfsParquetFile,
  OpfsParquetTable,
} from './opfs'
export { overlayViewBody } from './overlay-view'
export { createInsightRunner, mergeScope, scopeFor } from './runner'
export type { InsightRunner, InsightRunnerOptions, ScopedRunnerOptions, TableScope } from './runner'
export {
  attachParquetTables,
  attachParquetUrlTables,
  attachParquetUrlTablesResult,
  bootDuckDBWasm,
  BrowserAttachBudgetExceededError,
  browserAttachErrors,
  createBrowserAnalysisRuntime,
  isBrowserAttachError,
} from './runtime'
export type {
  AnalyzeResult,
  AttachedTablesHandle,
  AttachParquetTablesOptions,
  AttachParquetUrlTablesOptions,
  BootDuckDBWasmOptions,
  BrowserAnalysisRuntime,
  BrowserAttachError,
  BrowserParquetFile,
  BrowserParquetTable,
  BrowserParquetUrlTable,
  DuckDBWasmBootResult,
  QueryResult,
} from './runtime'
export { countries, dates, hourly_pages, page_queries, pages, queries, schema } from './schema'
export type { Schema } from './schema'

export { resolveWindow } from '@gscdump/engine/period'
export type { ComparisonMode, ResolvedWindow, ResolveWindowOptions, WindowPreset } from '@gscdump/engine/period'
