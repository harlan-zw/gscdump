/**
 * Generic factory: turns a `(sql, params) → rows` execute function plus a
 * dialect-specific `ResolverAdapter` into an `AnalysisQuerySource` with
 * an `executeSql` method and adapter capability metadata.
 *
 * Adapters (`engine-duckdb-wasm`, `engine-sqlite`, future Postgres / BigQuery)
 * reduce to driver glue + one call here. Keeps the typed-builder path,
 * the raw-SQL escape hatch, and capability reporting in a single place.
 */

import type { ResolverAdapter } from '../resolver/types'
import type { AnalysisQuerySource, AnalysisSourceKind, QueryRow, SourceCapabilities } from './source-types'
import { coerceRows } from '../coerce'
import { resolveToSQL } from '../resolver/compile'

export interface CreateSqlQuerySourceOptions<TKey extends string> {
  /** Debug-only identifier surfaced on the source for error messages. */
  name: string
  /** Telemetry tag stamped onto analyzer result meta. */
  kind?: AnalysisSourceKind
  /** Dialect-specific adapter; compiles `BuilderState` → `{ sql, params }`. */
  adapter: ResolverAdapter<TKey>
  /** Drives the underlying DB. Called for both typed queries and raw SQL. */
  execute: (sql: string, params: unknown[]) => Promise<QueryRow[]>
  /** Tenant id for multi-tenant dialects; forwarded to `resolveToSQL`. */
  siteId?: string | number
  /**
   * Search-type scope for multi-tenant dialects; forwarded to `resolveToSQL`.
   * `number` = int-encoded code (`SEARCH_TYPE_INT`) for INT `search_type`
   * catalogs (bound bare so the int partition prunes); `string` otherwise.
   */
  searchType?: string | number
  /** Additional capability flags merged on top of `adapter.capabilities`. */
  extraCapabilities?: Partial<SourceCapabilities>
}

export function createSqlQuerySource<TKey extends string>(
  options: CreateSqlQuerySourceOptions<TKey>,
): AnalysisQuerySource {
  const { name, kind, adapter, execute, siteId, searchType, extraCapabilities } = options
  return {
    name,
    kind,
    capabilities: { ...adapter.capabilities, ...extraCapabilities, adapter: true },
    adapter,
    siteId,
    async queryRows(state) {
      const resolved = resolveToSQL(state, { adapter, siteId, searchType })
      const rows = await execute(resolved.sql, resolved.params)
      return coerceRows(rows)
    },
    async executeSql(sql, params) {
      const rows = await execute(sql, params ?? [])
      return coerceRows(rows)
    },
  }
}
