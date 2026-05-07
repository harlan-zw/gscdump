/**
 * SQLite engine: wraps a sqlite-proxy-style executor (D1, libsql, sqlite3+
 * regexp) as an `AnalysisQuerySource` bound to a tenant siteId. Driver glue
 * only; `createSqlQuerySource` in `@gscdump/engine/source` owns the typed
 * builder + raw-SQL plumbing.
 */

import type { AnalysisQuerySource, QueryRow } from '@gscdump/engine/source'
import type { SqliteRowExecutor } from './runner'

import { createSqlQuerySource } from '@gscdump/engine/source'
import { createSqliteResolverAdapter, sqliteResolverAdapter } from './resolver-adapter'

export type SqliteQueryExecutor = SqliteRowExecutor

export interface EngineConfig {
  executor: SqliteQueryExecutor
  siteId: string | number
  /** Override for hosts that expose REGEXP (D1, libsql, sqlite3+regexp). */
  regex?: boolean
}

export function createEngine(config: EngineConfig): AnalysisQuerySource {
  const { executor, siteId, regex } = config
  const adapter = regex === undefined
    ? sqliteResolverAdapter
    : createSqliteResolverAdapter({ regex })

  return createSqlQuerySource({
    name: 'sqlite',
    kind: 'local',
    adapter,
    execute: async (sql, params) => {
      const result = await executor(sql, params, 'all')
      return result.rows as QueryRow[]
    },
    siteId,
  })
}
