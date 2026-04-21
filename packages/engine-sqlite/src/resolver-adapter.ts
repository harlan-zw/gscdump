/**
 * Sqlite-dialect {@link ResolverAdapter} — D1 `gsc_*` tables, `site_id` scoped.
 */

import type { ResolverAdapter } from '@gscdump/engine/resolver'
import type { SqliteRowExecutor } from './runner'

import { compileSqlite, createResolverAdapter } from '@gscdump/engine/resolver'
import { sql } from 'drizzle-orm'

import { schema } from './schema'

export type TableKey = keyof typeof schema

export interface CreateSqliteResolverAdapterOptions {
  regex?: boolean
}

export function createSqliteResolverAdapter(
  options: CreateSqliteResolverAdapterOptions = {},
): ResolverAdapter<TableKey> {
  return createResolverAdapter<TableKey>({
    schema,
    datasetToTableKey: {
      pages: 'gsc_pages',
      keywords: 'gsc_keywords',
      page_keywords: 'gsc_page_keywords',
      countries: 'gsc_countries',
      devices: 'gsc_devices',
    },
    metricCast: 'REAL',
    regexPredicate: (expr, pattern, negate) => negate
      ? sql`NOT (${expr} REGEXP ${pattern})`
      : sql`${expr} REGEXP ${pattern}`,
    tableLabel: 'sqlite/resolver-adapter',
    includeSiteId: true,
    compile: compileSqlite,
    capabilities: {
      regex: options.regex ?? false,
      comparisonJoin: true,
      windowTotals: true,
    },
  })
}

export const sqliteResolverAdapter = createSqliteResolverAdapter()

/**
 * One-shot probe that detects whether the host SQLite has a working REGEXP
 * function. SQLite ships REGEXP as a no-op stub by default; D1, libsql, and
 * sqlite3 with the regexp extension register a real implementation. Probe
 * once at adapter construction so per-query plan-time gating is honest.
 */
export async function probeSqliteRegex(executor: SqliteRowExecutor): Promise<boolean> {
  return executor(`SELECT 'a' REGEXP 'a' AS r`, [], 'all')
    .then(({ rows }) => rows.length > 0)
    .catch(() => false)
}

export interface CreateSqliteResolverAdapterFromExecutorOptions {
  executor: SqliteRowExecutor
}

/**
 * Async factory that probes REGEXP availability on `executor` and returns
 * a resolver adapter with `capabilities.regex` set accordingly. Prefer over
 * the manual `createSqliteResolverAdapter({ regex })` whenever you have
 * an executor handy.
 */
export async function createSqliteResolverAdapterFromExecutor(
  options: CreateSqliteResolverAdapterFromExecutorOptions,
): Promise<ResolverAdapter<TableKey>> {
  const regex = await probeSqliteRegex(options.executor)
  return createSqliteResolverAdapter({ regex })
}
