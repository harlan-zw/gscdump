/**
 * Canonical cross-package contracts. Type-only — zero runtime cost.
 *
 * Imported by @gscdump/engine, @gscdump/analysis, @gscdump/cli, @gscdump/mcp,
 * @gscdump/cloud as the single source of truth for cross-cutting types so
 * schema identifiers, tenant shape, and analyzer IO can't drift across
 * packages.
 */

// ------------------------------------------------------------------
// Schema primitives
// ------------------------------------------------------------------

/** Logical table / dataset identifier. Canonical across query builder + storage engine. */
export type TableName = 'pages' | 'keywords' | 'countries' | 'devices' | 'page_keywords' | 'search_appearance'

/** Untyped row shape crossing storage/query boundaries. */
export type Row = Record<string, unknown>

export type ColumnType = 'DATE' | 'VARCHAR' | 'INTEGER' | 'BIGINT' | 'DOUBLE'

export interface ColumnDef {
  name: string
  type: ColumnType
  nullable: boolean
}

export interface TableSchema {
  name: TableName
  columns: ColumnDef[]
  sortKey: string[]
  /**
   * Monotonically increasing version. Tagged onto every manifest entry written
   * for this table; bump when columns are added/removed/retyped so readers can
   * detect stale on-disk data.
   */
  version: number
}

/** Tenant identity for multi-user / multi-site storage. */
export interface TenantCtx {
  userId: string
  siteId?: string
}
