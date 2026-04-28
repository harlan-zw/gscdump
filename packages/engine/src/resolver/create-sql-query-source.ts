/**
 * Generic factory: turns a `(sql, params) → rows` execute function plus a
 * dialect-specific `ResolverAdapter` into a `SqlQuerySource`.
 *
 * Adapters (`engine-duckdb-wasm`, `engine-sqlite`, future Postgres / BigQuery)
 * reduce to driver glue + one call here. Keeps the typed-builder path,
 * the raw-SQL escape hatch, and capability reporting in a single place.
 */

import type { QueryRow, SourceCapabilities, SqlQuerySource } from './source-types'
import type { ResolverAdapter } from './types'
import { resolveToSQL } from './compiler'

export interface CreateSqlQuerySourceOptions<TKey extends string> {
  /** Debug-only identifier surfaced on the source for error messages. */
  name: string
  /** Dialect-specific adapter; compiles `BuilderState` → `{ sql, params }`. */
  adapter: ResolverAdapter<TKey>
  /** Drives the underlying DB. Called for both typed queries and raw SQL. */
  execute: (sql: string, params: unknown[]) => Promise<QueryRow[]>
  /** Tenant id for multi-tenant dialects; forwarded to `resolveToSQL`. */
  siteId?: string | number
  /** Additional capability flags merged on top of `adapter.capabilities`. */
  extraCapabilities?: Partial<SourceCapabilities>
}

export function createSqlQuerySource<TKey extends string>(
  options: CreateSqlQuerySourceOptions<TKey>,
): SqlQuerySource {
  const { name, adapter, execute, siteId, extraCapabilities } = options
  return {
    name,
    capabilities: { ...adapter.capabilities, ...extraCapabilities },
    async queryRows(state) {
      const resolved = resolveToSQL(state, { adapter, siteId })
      return execute(resolved.sql, resolved.params)
    },
    executeSql(sql, params) {
      return execute(sql, params ?? [])
    },
  }
}
