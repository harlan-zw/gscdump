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
  },
  keywords: {
    name: 'keywords',
    columns: [
      { name: 'query', type: 'VARCHAR', nullable: false },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'query'],
  },
  countries: {
    name: 'countries',
    columns: [
      { name: 'country', type: 'VARCHAR', nullable: false },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'country'],
  },
  devices: {
    name: 'devices',
    columns: [
      { name: 'device', type: 'VARCHAR', nullable: false },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'device'],
  },
  page_keywords: {
    name: 'page_keywords',
    columns: [
      { name: 'url', type: 'VARCHAR', nullable: false },
      { name: 'query', type: 'VARCHAR', nullable: false },
      DATE_COL,
      ...METRIC_COLS,
    ],
    sortKey: ['date', 'url', 'query'],
  },
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
  const hasQuery = dims.has('query') || dims.has('queryCanonical')
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
  if (dim === 'queryCanonical')
    return 'query_canonical'
  return dim
}
