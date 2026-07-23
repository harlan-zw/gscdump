/**
 * Canonical pg-core {@link ResolverAdapter} for the parquet / DuckDB read
 * path. DuckDB (node + wasm) speaks Postgres-flavored SQL, so the same
 * adapter compiles queries for both runtimes. Single-tenant: `siteIdColRef`
 * is absent.
 */

import type { TableName } from '@gscdump/contracts'
import type { SQL } from 'drizzle-orm'
import type { ResolverAdapter } from './types'
import { DEFAULT_PARTITION_KEY_ENCODING } from '@gscdump/lakehouse/schema'
import { sql } from 'drizzle-orm'
import { varchar } from 'drizzle-orm/pg-core/columns/varchar'
import { PgDialect } from 'drizzle-orm/pg-core/dialect'
import { pgTable } from 'drizzle-orm/pg-core/table'
import { drizzleSchema } from '../drizzle-schema'
import { createResolverAdapter } from './adapter'

export type PgTableKey = TableName

const pgDialect = new PgDialect()

/**
 * Iceberg variant of {@link drizzleSchema}. Each table is redeclared with the
 * two multi-tenant identity columns (`site_id`, `search_type`) prepended so
 * `colRef` can resolve them — the canonical parquet schema omits both columns
 * since per-site object keys imply site identity. Table NAMES are identical
 * to the base schema, so SQL output is unchanged except for the injected
 * WHERE predicates.
 */
function withTenantCols<T>(
  tableName: string,
  baseTable: T,
): T & { site_id: ReturnType<ReturnType<typeof varchar>['notNull']>, search_type: ReturnType<ReturnType<typeof varchar>['notNull']> } {
  // Re-build a drizzle pgTable with the tenant cols plus a passthrough of base
  // column NAMES. We cannot deep-clone drizzle column objects, so we shadow
  // every base column with a freshly-declared varchar/etc. Cheaper: extract
  // each base column's drizzle metadata and re-emit. Simpler: declare the
  // tenant cols separately and merge them with the existing column objects;
  // colRef only needs `schema[tableKey][colName]` to be SOMETHING the drizzle
  // sql template can render, which the existing column objects already are.
  const t = pgTable(tableName, {
    site_id: varchar('site_id').notNull(),
    search_type: varchar('search_type').notNull(),
  })
  return { ...baseTable, site_id: t.site_id, search_type: t.search_type } as any
}

const icebergSchema = {
  pages: withTenantCols('pages', drizzleSchema.pages),
  queries: withTenantCols('queries', drizzleSchema.queries),
  countries: withTenantCols('countries', drizzleSchema.countries),
  page_queries: withTenantCols('page_queries', drizzleSchema.page_queries),
  dates: withTenantCols('dates', drizzleSchema.dates),
  search_appearance: withTenantCols('search_appearance', drizzleSchema.search_appearance),
  search_appearance_pages: withTenantCols('search_appearance_pages', drizzleSchema.search_appearance_pages),
  search_appearance_queries: withTenantCols('search_appearance_queries', drizzleSchema.search_appearance_queries),
  search_appearance_page_queries: withTenantCols('search_appearance_page_queries', drizzleSchema.search_appearance_page_queries),
  hourly_pages: withTenantCols('hourly_pages', drizzleSchema.hourly_pages),
}

function compilePg(query: SQL): { sql: string, params: unknown[] } {
  const compiled = pgDialect.sqlToQuery(query)
  return { sql: compiled.sql, params: compiled.params as unknown[] }
}

const PG_BASE_CONFIG = {
  schema: drizzleSchema,
  datasetToTableKey: {
    pages: 'pages',
    queries: 'queries',
    page_queries: 'page_queries',
    countries: 'countries',
    dates: 'dates',
    search_appearance: 'search_appearance',
    search_appearance_pages: 'search_appearance_pages',
    search_appearance_queries: 'search_appearance_queries',
    search_appearance_page_queries: 'search_appearance_page_queries',
    hourly_pages: 'hourly_pages',
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
export interface ResolverAdapterOptions {
  /**
   * `queryDim` reads canonical from a joined query dimension. `column` is only
   * for derived canonical rollup relations whose primary relation already
   * carries a null-free `query_canonical` output column.
   */
  queryCanonicalSource?: 'queryDim' | 'column'
}

export interface R2SqlResolverAdapterOptions extends ResolverAdapterOptions {
  /**
   * R2 SQL string partition equality can undercount on identity partitions;
   * string-encoded catalogs use CONCAT(col, '') in partition predicates. Int
   * catalogs do not need the workaround and keep bare equality for pruning.
   */
  partitionKeyEncoding?: 'string' | 'int'
}

export function createParquetResolverAdapter(options: ResolverAdapterOptions = {}): ResolverAdapter<PgTableKey> {
  return createResolverAdapter<PgTableKey>({
    ...PG_BASE_CONFIG,
    tableLabel: 'parquet-resolver-adapter',
    queryCanonicalSource: options.queryCanonicalSource ?? 'queryDim',
    tableRef: tk => sql.raw(`read_parquet({{FILES}}, union_by_name = true) AS "${tk}"`),
    queryDimTableRef: () => sql.raw('read_parquet({{QUERY_DIM}}, union_by_name = true) AS "query_dim"'),
  })
}

/**
 * Multi-tenant pg-flavored adapter for the Iceberg / R2 SQL read path.
 * Identical SQL output to `pgResolverAdapter` except WHERE clauses inject
 * `site_id = ?` AND `search_type = ?` automatically when those scopes are
 * passed to `resolveToSQL`. Required for the Iceberg fact tables which are
 * shared across tenants — querying without these predicates would leak
 * cross-tenant data. Single-use: the adapter has no `tableRef` override,
 * so callers must rewrite bare table names to their qualified form (e.g.
 * `${namespace}.pages`) before sending to R2 SQL.
 */
export function createIcebergResolverAdapter(options: ResolverAdapterOptions = {}): ResolverAdapter<PgTableKey> {
  return createResolverAdapter<PgTableKey>({
    ...PG_BASE_CONFIG,
    schema: icebergSchema,
    includeSiteId: true,
    includeSearchType: true,
    tableLabel: 'iceberg-resolver-adapter',
    queryCanonicalSource: options.queryCanonicalSource ?? 'queryDim',
    // `icebergSchema` table entries are plain object spreads of drizzle tables,
    // so they preserve column symbols (for `colRef`) but lose the table-level
    // symbols drizzle needs to render `${schema[tk]}` as a name (it falls back
    // to `[object Object]`). Emit the bare quoted name; gscdump.com's qualifier
    // rewrites `"pages"` → `gsc.pages` before sending to R2 SQL.
    tableRef: tk => sql.raw(`"${tk}"`),
    queryDimTableRef: () => sql.raw('"query_dim"'),
  })
}

/**
 * R2 SQL adapter for the Iceberg fact tables.
 *
 * It shares the multi-tenant Iceberg schema with `createIcebergResolverAdapter`
 * but models R2 SQL's narrower execution surface: no window-total plans and no
 * comparison joins. Int-partition catalogs are the default and emit bare
 * equality predicates for pruning. Legacy string-partition catalogs must pass
 * `partitionKeyEncoding: 'string'` to emit `CONCAT(partition_col, '') = ?`,
 * working around R2 SQL's partition-string equality undercount while preserving
 * bound params.
 */
export function createR2SqlResolverAdapter(
  options: R2SqlResolverAdapterOptions = {},
): ResolverAdapter<PgTableKey> {
  const adapter = createResolverAdapter<PgTableKey>({
    ...PG_BASE_CONFIG,
    schema: icebergSchema,
    includeSiteId: true,
    includeSearchType: true,
    tableLabel: 'r2-sql-resolver-adapter',
    queryCanonicalSource: options.queryCanonicalSource ?? 'queryDim',
    capabilities: {
      regex: false,
      comparisonJoin: false,
      windowTotals: false,
    },
    tableRef: tk => sql.raw(`"${tk}"`),
    queryDimTableRef: () => sql.raw('"query_dim"'),
  })

  if ((options.partitionKeyEncoding ?? DEFAULT_PARTITION_KEY_ENCODING) === 'int')
    return adapter

  return {
    ...adapter,
    siteIdColRef: tk => sql`CONCAT(${adapter.siteIdColRef!(tk)}, '')`,
    searchTypeColRef: tk => sql`CONCAT(${adapter.searchTypeColRef!(tk)}, '')`,
  }
}
