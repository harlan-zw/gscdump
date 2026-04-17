/**
 * Sqlite insight runner — a drizzle handle bound to an async executor.
 *
 * Uses drizzle's sqlite-proxy adapter so the runner works against anything
 * that can run SQL + params and return rows: the D1 HTTP API, a direct
 * D1Database binding wrapped, libsql-over-HTTP, etc. Callers supply the
 * `executor` callback.
 *
 * For D1 HTTP (`queryUserD1` in gscdump.com), rows come back as objects
 * keyed by column name. drizzle's default mapper expects positional arrays
 * when `fields` are set (typed .select() calls). Use `rowsAsArrays: true`
 * on the runner to convert — `.execute(sql\`...\`)` returns raw objects
 * regardless.
 */

import type { SQL } from 'drizzle-orm'
import type { AsyncRemoteCallback, SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'

import type { ResolvedWindow } from '../window'
import type { Schema } from './schema'

import { and, eq, gte, lte } from 'drizzle-orm'

import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/sqlite-proxy'

import { schema } from './schema'

const dialect = new SQLiteAsyncDialect()

/**
 * Compile a drizzle `sql` expression to `{ sql, params }` for executors
 * that don't go through the runner (e.g. D1 HTTP via queryUserD1). Column
 * refs from the sqlite schema serialize with quoted names, so typed refs
 * stay honest without constructing a full drizzle query.
 */
export function compileSqlite(query: SQL): { sql: string, params: unknown[] } {
  const compiled = dialect.sqlToQuery(query)
  return { sql: compiled.sql, params: compiled.params as unknown[] }
}

export type SqliteRowExecutor = (
  sql: string,
  params: unknown[],
  method: 'run' | 'all' | 'values' | 'get',
) => Promise<{ rows: unknown[] }>

export interface SqliteInsightRunnerOptions {
  executor: SqliteRowExecutor
  logger?: boolean
  /**
   * Convert object rows to positional arrays before handing to drizzle.
   * D1 HTTP + most REST-style drivers return objects; set true when the
   * executor yields `{ col: value }` rows.
   */
  rowsAsArrays?: boolean
}

export interface SqliteInsightRunner {
  db: SqliteRemoteDatabase<Schema>
}

export function createSqliteInsightRunner(opts: SqliteInsightRunnerOptions): SqliteInsightRunner {
  const { executor, logger, rowsAsArrays } = opts

  const callback: AsyncRemoteCallback = async (sql, params, method) => {
    const result = await executor(sql, params, method)
    if (!rowsAsArrays)
      return { rows: result.rows as any[] }
    const rows = result.rows as unknown[]
    const mapped = rows.map((r) => {
      if (Array.isArray(r))
        return r
      if (r && typeof r === 'object')
        return Object.values(r as Record<string, unknown>)
      return r
    })
    return { rows: mapped as any[] }
  }

  const db = drizzle<Schema>(callback, { schema, logger })
  return { db }
}

export interface ScopedRunnerOptions {
  siteId?: string
  window?: ResolvedWindow
  /** Inclusive lower bound for `date`. Ignored if `window` is supplied. */
  startDate?: string
  /** Inclusive upper bound for `date`. Ignored if `window` is supplied. */
  endDate?: string
}

export interface TableScope {
  wherePredicates: SQL[]
  window?: ResolvedWindow
  siteId?: string
}

/**
 * Per-table predicate set from {siteId, window}. Unlike the /browser
 * variant, every sqlite table has `site_id` so the siteId predicate is
 * always emitted when supplied.
 *
 * Date bounds come from either a resolved window or bare startDate/endDate
 * (one or both). This lets callers pass unbounded query-string params
 * through without first normalizing them.
 */
export function scopeFor(
  table: keyof Schema,
  opts: ScopedRunnerOptions,
): TableScope {
  const t = schema[table] as Record<string, any>
  const predicates: SQL[] = []

  if (opts.siteId && 'site_id' in t)
    predicates.push(eq(t.site_id, opts.siteId))

  if ('date' in t) {
    const start = opts.window?.start ?? opts.startDate
    const end = opts.window?.end ?? opts.endDate
    if (start)
      predicates.push(gte(t.date, start))
    if (end)
      predicates.push(lte(t.date, end))
  }

  return { wherePredicates: predicates, window: opts.window, siteId: opts.siteId }
}

export function mergeScope(scope: TableScope, ...extra: SQL[]): SQL | undefined {
  const all = [...scope.wherePredicates, ...extra].filter(Boolean) as SQL[]
  if (all.length === 0)
    return undefined
  return and(...all)
}
