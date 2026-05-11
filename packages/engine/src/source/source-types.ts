/**
 * Source-layer contracts. Lives in engine because `createSqlQuerySource`
 * (engine-side factory) produces an `AnalysisQuerySource`; analyzer dispatch
 * in `@gscdump/engine/analyzer` consumes these directly.
 *
 * Single Interface; capability flags declare what's available. SQL execution
 * is opt-in via `capabilities.executeSql + executeSql` method (the two move
 * together — factories MUST set both or neither). Telemetry-only `kind` tag
 * names the storage runtime for downstream meta annotation.
 */

import type { TableName } from '@gscdump/contracts'
import type { BuilderState } from 'gscdump/query'
import type { PlannerCapabilities } from 'gscdump/query/plan'
import type { ResolverAdapter } from '../resolver/types'

export type QueryRow = Record<string, unknown>

export interface FileSet {
  table: TableName
  partitions: string[]
}

export interface ExecuteSqlOptions {
  fileSets?: Record<string, FileSet>
}

/**
 * Flat capability bag: planner-side flags (`regex`, `comparisonJoin`, ...)
 * mixed with storage-side flags. `executeSql: true` means the source provides
 * the `executeSql` method; analyzer dispatch reads this single flag instead
 * of probing the function shape.
 */
export interface SourceCapabilities extends PlannerCapabilities {
  executeSql?: boolean
  attachedTables?: boolean
  fileSets?: boolean
  /**
   * true iff the source provides a `ResolverAdapter` for analyzers that
   * compose SQL from a typed `BuilderState` at plan-build time.
   */
  adapter?: boolean
}

export type AnalysisSourceKind = 'local' | 'browser' | 'live' | 'in-memory' | 'composite' | 'attached-table'

export interface AnalysisQuerySource {
  name?: string
  /** Telemetry tag stamped onto analyzer result meta; not used for routing. */
  kind?: AnalysisSourceKind
  capabilities: SourceCapabilities
  /**
   * Dialect adapter surfaced for analyzers that compose SQL from a
   * `BuilderState` at plan-build time. Optional for pure row sources.
   */
  adapter?: ResolverAdapter<any>
  /** Tenant scope; multi-tenant dialects (sqlite/D1) require it, parquet omits it. */
  siteId?: string | number
  queryRows: (state: BuilderState) => Promise<QueryRow[]>
  /**
   * Present iff `capabilities.executeSql === true`. Receives the compiled
   * SQL plan with `{{FILES}}` placeholders; sources that advertise
   * `capabilities.fileSets` consume `opts.fileSets`, others ignore them.
   */
  executeSql?: (sql: string, params?: unknown[], opts?: ExecuteSqlOptions) => Promise<QueryRow[]>
}
