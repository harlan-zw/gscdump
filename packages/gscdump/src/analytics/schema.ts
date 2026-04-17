import type { TableName } from './storage'

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
   * Monotonically increasing version number. Tagged onto every manifest entry written for this table.
   * Bump when columns are added/removed/retyped so readers can detect stale on-disk data and upgrade it.
   */
  version: number
}

const METRIC_COLS: ColumnDef[] = [
  { name: 'clicks', type: 'INTEGER', nullable: false },
  { name: 'impressions', type: 'INTEGER', nullable: false },
  { name: 'sum_position', type: 'DOUBLE', nullable: false },
]

const DATE_COL: ColumnDef = { name: 'date', type: 'DATE', nullable: false }

export const SCHEMAS: Record<TableName, TableSchema> = {
  pages: {
    name: 'pages',
    columns: [
      { name: 'url', type: 'VARCHAR', nullable: false },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'url'],
    version: 1,
  },
  keywords: {
    name: 'keywords',
    columns: [
      { name: 'query', type: 'VARCHAR', nullable: false },
      { name: 'query_canonical', type: 'VARCHAR', nullable: true },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'query'],
    version: 2,
  },
  countries: {
    name: 'countries',
    columns: [
      { name: 'country', type: 'VARCHAR', nullable: false },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'country'],
    version: 1,
  },
  devices: {
    name: 'devices',
    columns: [
      { name: 'device', type: 'VARCHAR', nullable: false },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'device'],
    version: 1,
  },
  page_keywords: {
    name: 'page_keywords',
    columns: [
      { name: 'url', type: 'VARCHAR', nullable: false },
      { name: 'query', type: 'VARCHAR', nullable: false },
      { name: 'query_canonical', type: 'VARCHAR', nullable: true },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'url', 'query'],
    version: 2,
  },
}

export function currentSchemaVersion(table: TableName): number {
  return SCHEMAS[table].version
}

export function schemaFor(table: TableName): TableSchema {
  return SCHEMAS[table]
}

const METRIC_TABLES: readonly TableName[] = ['pages', 'keywords', 'countries', 'devices', 'page_keywords']

export function allTables(): readonly TableName[] {
  return METRIC_TABLES
}

export function inferTable(dimensions: readonly string[]): TableName {
  const dims = new Set(dimensions)
  const hasPage = dims.has('page')
  const hasQuery = dims.has('query')
  if (hasPage && hasQuery)
    return 'page_keywords'
  if (hasQuery)
    return 'keywords'
  if (hasPage)
    return 'pages'
  if (dims.has('country'))
    return 'countries'
  if (dims.has('device'))
    return 'devices'
  return 'keywords'
}

export function dimensionToColumn(dim: string, _table: TableName): string {
  if (dim === 'page')
    return 'url'
  return dim
}
