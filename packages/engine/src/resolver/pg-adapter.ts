/**
 * Canonical pg-core {@link ResolverAdapter} for the parquet / DuckDB read
 * path. DuckDB (node + wasm) speaks Postgres-flavored SQL, so the same
 * adapter compiles queries for both runtimes. Single-tenant: `siteIdColRef`
 * is absent.
 */

import type { SQL } from 'drizzle-orm'
import type { TableName } from '@gscdump/contracts'
import type { ResolverAdapter } from './types'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { drizzleSchema } from '../drizzle-schema'
import { createResolverAdapter } from './adapter'

export type PgTableKey = TableName

const pgDialect = new PgDialect()

function compilePg(query: SQL): { sql: string, params: unknown[] } {
  const compiled = pgDialect.sqlToQuery(query)
  return { sql: compiled.sql, params: compiled.params as unknown[] }
}

const PG_BASE_CONFIG = {
  schema: drizzleSchema,
  datasetToTableKey: {
    pages: 'pages',
    keywords: 'keywords',
    page_keywords: 'page_keywords',
    countries: 'countries',
    devices: 'devices',
    search_appearance: 'search_appearance',
  },
  metricCast: 'DOUBLE',
  regexPredicate: (expr, pattern, negate) => negate
    ? sql`NOT regexp_matches(${expr}, ${pattern})`
    : sql`regexp_matches(${expr}, ${pattern})`,
  urlToPathExpr: (col: string) => `CASE WHEN ${col} LIKE 'http%' THEN COALESCE(NULLIF(regexp_replace(${col}, '^https?://[^/]+', ''), ''), '/') ELSE ${col} END`,
  includeSiteId: false,
  compile: compilePg,
  capabilities: {
    regex: true,
    comparisonJoin: true,
    windowTotals: true,
  },
} satisfies Omit<Parameters<typeof createResolverAdapter<PgTableKey>>[0], 'tableLabel' | 'tableRef'>

export const pgResolverAdapter: ResolverAdapter<PgTableKey> = createResolverAdapter<PgTableKey>({
  ...PG_BASE_CONFIG,
  tableLabel: 'pg-resolver-adapter',
})

/**
 * Parquet-aware variant of {@link pgResolverAdapter}. Identical SQL output
 * except FROM clauses emit `read_parquet({{FILES}}, union_by_name = true) AS
 * "${tk}"`. The runSQL pipeline substitutes `{{FILES}}` with R2 object keys
 * resolved from the manifest. The `AS "${tk}"` alias is mandatory — drizzle
 * compiles `colRef` to table-qualified `"pages"."url"`, which would not
 * resolve against an unaliased FROM.
 *
 * Single-use: build a fresh adapter per query. Cheap (no I/O) and avoids
 * accidental adapter caching that would lock in a stale `{{FILES}}` set.
 */
export function createParquetResolverAdapter(): ResolverAdapter<PgTableKey> {
  return createResolverAdapter<PgTableKey>({
    ...PG_BASE_CONFIG,
    tableLabel: 'parquet-resolver-adapter',
    tableRef: tk => sql.raw(`read_parquet({{FILES}}, union_by_name = true) AS "${tk}"`),
  })
}
