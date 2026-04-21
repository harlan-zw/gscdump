/**
 * Source-layer contracts. Lives in engine because `createSqlQuerySource`
 * (engine-side factory) produces `SqlQuerySource`; analyzers in analysis
 * re-export these via `@gscdump/analysis/source` for their own dispatcher.
 *
 * Kept dialect- and storage-agnostic: only the bare SQL-source contract
 * plus file-set refs for `{{FILES}}` substitution over partitioned parquet.
 */

import type { TableName } from 'gscdump/contracts'
import type { BuilderState } from 'gscdump/query'
import type { PlannerCapabilities } from 'gscdump/query/plan'

export type QueryRow = Record<string, unknown>

export interface FileSet {
  table: TableName
  partitions: string[]
}

export interface ExecuteSqlOptions {
  fileSets?: Record<string, FileSet>
}

export interface SourceCapabilities extends PlannerCapabilities {
  attachedTables?: boolean
  fileSets?: boolean
  localSource?: boolean
}

export interface RowQuerySource {
  name?: string
  capabilities: SourceCapabilities
  queryRows: (state: BuilderState) => Promise<QueryRow[]>
  readonly executeSql?: undefined
}

export interface SqlQuerySource {
  name?: string
  capabilities: SourceCapabilities
  queryRows: (state: BuilderState) => Promise<QueryRow[]>
  executeSql: (sql: string, params?: unknown[], opts?: ExecuteSqlOptions) => Promise<QueryRow[]>
}

export type AnalysisQuerySource = RowQuerySource | SqlQuerySource

export function isSqlQuerySource(s: AnalysisQuerySource): s is SqlQuerySource {
  return typeof s.executeSql === 'function'
}
