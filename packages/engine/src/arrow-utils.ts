/**
 * Arrow → row conversion shared by every engine adapter.
 *
 * DuckDB returns Arrow tables; drizzle / consumers want plain row objects.
 * Read Arrow vectors directly to avoid creating a proxy for every row.
 * Simpler table wrappers can supply row objects through `toArray()`.
 */

export interface ArrowTableLike {
  toArray: () => Array<Record<string, unknown> & { toJSON?: () => Record<string, unknown> }>
}

interface ColumnarArrowTable extends ArrowTableLike {
  numRows: number
  schema: { fields: { name: string }[] }
  getChildAt: (index: number) => { get: (index: number) => unknown }
}

export function arrowToRows(result: unknown): Record<string, unknown>[] {
  const table = result as ColumnarArrowTable | null
  if (
    !Array.isArray(table)
    && typeof table?.getChildAt === 'function'
    && Array.isArray(table.schema?.fields)
    && Number.isInteger(table.numRows)
    && table.numRows >= 0
  ) {
    const rows: Record<string, unknown>[] = Array.from({ length: table.numRows }, () => ({}))
    // Vector.get preserves Arrow's null, bigint, date, and nested-value handling.
    // Index lookup also preserves duplicate column names: the last value wins.
    for (let columnIndex = 0; columnIndex < table.schema.fields.length; columnIndex++) {
      const name = table.schema.fields[columnIndex]!.name
      const column = table.getChildAt(columnIndex)
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++)
        rows[rowIndex]![name] = column.get(rowIndex)
    }
    return rows
  }
  const r = result as ArrowTableLike | Array<Record<string, unknown>>
  const arr = Array.isArray(r) ? r : (typeof r?.toArray === 'function' ? r.toArray() : [])
  if (!arr || arr.length === 0)
    return []
  if (typeof (arr[0] as any)?.toJSON === 'function')
    return (arr as any[]).map(r => r.toJSON())
  return arr as Record<string, unknown>[]
}
