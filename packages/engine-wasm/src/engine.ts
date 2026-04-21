/**
 * DuckDB-WASM engine: wraps an in-browser DuckDB-WASM connection as a
 * {@link SqlQuerySource}. Delegates the typed-builder + raw-SQL plumbing to
 * `createSqlQuerySource` so the adapter package stays driver-glue-only.
 */

import type { QueryRow, SqlQuerySource } from '@gscdump/engine/resolver'

import { createSqlQuerySource } from '@gscdump/engine/resolver'
import { browserResolverAdapter } from './resolver-adapter'

export interface BrowserQueryRunner {
  query: (sql: string, params?: unknown[]) => Promise<QueryRow[]>
}

export interface EngineConfig {
  runner: BrowserQueryRunner
}

export function createEngine(config: EngineConfig): SqlQuerySource {
  const { runner } = config
  return createSqlQuerySource({
    name: 'browser',
    adapter: browserResolverAdapter,
    execute: (sql, params) => runner.query(sql, params),
    extraCapabilities: { attachedTables: true },
  })
}
