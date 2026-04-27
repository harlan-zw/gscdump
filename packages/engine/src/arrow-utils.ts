/**
 * Arrow → row conversion shared by every engine adapter.
 *
 * DuckDB returns Arrow tables; drizzle / consumers want plain row objects.
 * `toArray()` yields Arrow row proxies; `.toJSON()` materializes them, but
 * some Arrow versions skip `.toJSON` and yield plain objects already.
 */

export interface ArrowTableLike {
  toArray: () => Array<Record<string, unknown> & { toJSON?: () => Record<string, unknown> }>
}

export function arrowToRows(result: unknown): Record<string, unknown>[] {
  const r = result as ArrowTableLike | Array<Record<string, unknown>>
  const arr = Array.isArray(r) ? r : (typeof r?.toArray === 'function' ? r.toArray() : [])
  if (!arr || arr.length === 0)
    return []
  if (typeof (arr[0] as any)?.toJSON === 'function')
    return (arr as any[]).map(r => r.toJSON())
  return arr as Record<string, unknown>[]
}
