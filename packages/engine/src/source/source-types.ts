/**
 * Source-layer contracts. Lives in engine because `createSqlQuerySource`
 * (engine-side factory) produces an `AnalysisQuerySource`; analyzer dispatch
 * in `@gscdump/engine/analyzer` consumes these directly.
 *
 * Single Interface; capability flags declare what's available. SQL execution
 * is opt-in via the optional `executeSql` method; callers test for presence
 * (`typeof source.executeSql === 'function'`). Telemetry-only `kind` tag
 * names the storage runtime for downstream meta annotation.
 *
 * Source invariant: rows returned from `queryRows` and `executeSql` MUST be
 * BigInt-free. Source factories own this coercion (see `coerceRows`).
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
 * mixed with storage-side flags. SQL execution is not a capability flag —
 * callers probe `typeof source.executeSql === 'function'`.
 */
export interface SourceCapabilities extends PlannerCapabilities {
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
   * Optional raw-SQL escape hatch. Receives the compiled SQL plan with
   * `{{FILES}}` placeholders; sources that advertise `capabilities.fileSets`
   * consume `opts.fileSets`, others ignore them. Implementations MUST coerce
   * BigInts to numbers before returning (see Source invariant above).
   */
  executeSql?: (sql: string, params?: unknown[], opts?: ExecuteSqlOptions) => Promise<QueryRow[]>
}
