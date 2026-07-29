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

import type { ScopedRunnerOptions, TableScope } from '@gscdump/engine/scope'

import type { SQL } from 'drizzle-orm'
import type { Schema as DrizzleSchema, ExtractTablesWithRelations } from 'drizzle-orm/relations'
import type { AsyncRemoteCallback, SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import type { Schema as AnalyticsSchema } from './schema'

import { createScopedHelpers } from '@gscdump/engine/scope'

import { buildRelations } from 'drizzle-orm/relations'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/sqlite-proxy'

import { schema } from './schema'

export type { ScopedRunnerOptions, TableScope }

type SchemaRelations<TSchema extends DrizzleSchema> = ExtractTablesWithRelations<Record<string, never>, TSchema>

const sqliteDialect = new SQLiteDialect()

export function compileSqlite(query: SQL): { sql: string, params: unknown[] } {
  const compiled = sqliteDialect.sqlToQuery(query)
  return { sql: compiled.sql, params: compiled.params as unknown[] }
}

export type SqliteRowExecutor = (
  sql: string,
  params: unknown[],
  method: 'run' | 'all' | 'values' | 'get',
) => Promise<{ rows: unknown[] }>

export interface SqliteInsightRunnerOptions<TSchema extends DrizzleSchema = AnalyticsSchema> {
  executor: SqliteRowExecutor
  logger?: boolean
  /**
   * Convert object rows to positional arrays before handing to drizzle.
   * D1 HTTP + most REST-style drivers return objects; set true when the
   * executor yields `{ col: value }` rows.
   */
  rowsAsArrays?: boolean
  /**
   * Override the bundled gsc_* schema. Pass an extended schema (superset
   * of the upstream tables) when the consumer DB carries additional tables
   * like sitemaps or indexing state. Defaults to the bundled schema.
   */
  schema?: TSchema
}

export interface SqliteInsightRunner<TSchema extends DrizzleSchema = AnalyticsSchema> {
  db: SqliteRemoteDatabase<SchemaRelations<TSchema>>
}

export function createSqliteInsightRunner<TSchema extends DrizzleSchema = AnalyticsSchema>(
  opts: SqliteInsightRunnerOptions<TSchema>,
): SqliteInsightRunner<TSchema> {
  const { executor, logger, rowsAsArrays, schema: schemaOverride } = opts

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

  const finalSchema = (schemaOverride ?? schema) as TSchema
  const relations = buildRelations(finalSchema, {})
  const db = drizzle<SchemaRelations<TSchema>>(callback, { relations, logger })
  return { db }
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
const scopedHelpers = createScopedHelpers(schema)

export const scopeFor = scopedHelpers.scopeFor
export const mergeScope = scopedHelpers.mergeScope
