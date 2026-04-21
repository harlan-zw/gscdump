/**
 * Canonical pg-core {@link ResolverAdapter} for the parquet / DuckDB read
 * path. DuckDB (node + wasm) speaks Postgres-flavored SQL, so the same
 * adapter compiles queries for both runtimes. Single-tenant: `siteIdColRef`
 * is absent.
 *
 * Engine-wasm re-exports this as `browserResolverAdapter` for historical
 * reasons; new code should import `pgResolverAdapter` directly.
 */

import type { TableName } from 'gscdump/contracts'
import type { ResolverAdapter } from './types'
import { sql } from 'drizzle-orm'
import { drizzleSchema } from '../drizzle-schema'
import { createResolverAdapter } from './adapter'
import { compilePg } from './dialects'

export type PgTableKey = TableName

export const pgResolverAdapter: ResolverAdapter<PgTableKey> = createResolverAdapter<PgTableKey>({
  schema: drizzleSchema,
  datasetToTableKey: {
    pages: 'pages',
    keywords: 'keywords',
    page_keywords: 'page_keywords',
    countries: 'countries',
    devices: 'devices',
  },
  metricCast: 'DOUBLE',
  regexPredicate: (expr, pattern, negate) => negate
    ? sql`NOT regexp_matches(${expr}, ${pattern})`
    : sql`regexp_matches(${expr}, ${pattern})`,
  tableLabel: 'pg-resolver-adapter',
  includeSiteId: false,
  compile: compilePg,
  capabilities: {
    regex: true,
    comparisonJoin: true,
    windowTotals: true,
  },
})
