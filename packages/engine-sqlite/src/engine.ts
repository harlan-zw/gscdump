/**
 * SQLite engine: wraps a sqlite-proxy-style executor (D1, libsql, sqlite3+
 * regexp) as a {@link SqlQuerySource} bound to a tenant siteId. Driver glue
 * only — `createSqlQuerySource` in `@gscdump/analysis/query` owns the typed
 * builder + raw-SQL plumbing.
 */

import type { QueryRow, SqlQuerySource } from '@gscdump/engine/resolver'

import { createSqlQuerySource } from '@gscdump/engine/resolver'
import { createSqliteResolverAdapter, sqliteResolverAdapter } from './resolver-adapter'

export type SqliteQueryExecutor = (
  sql: string,
  params: unknown[],
  method: 'run' | 'all' | 'values' | 'get',
) => Promise<{ rows: unknown[] }>

export interface EngineConfig {
  executor: SqliteQueryExecutor
  siteId: string | number
  /** Override for hosts that expose REGEXP (D1, libsql, sqlite3+regexp). */
  regex?: boolean
}

export function createEngine(config: EngineConfig): SqlQuerySource {
  const { executor, siteId, regex } = config
  const adapter = regex === undefined
    ? sqliteResolverAdapter
    : createSqliteResolverAdapter({ regex })

  return createSqlQuerySource({
    name: 'sqlite',
    adapter,
    execute: async (sql, params) => {
      const result = await executor(sql, params, 'all')
      return result.rows as QueryRow[]
    },
    siteId,
  })
}
