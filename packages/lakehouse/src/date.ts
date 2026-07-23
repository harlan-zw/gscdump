const DAY_MILLIS = 86_400_000

/**
 * Convert a `YYYY-MM-DD` string / `Date` / already-numeric day-count to the
 * integer "days since the Unix epoch" the Iceberg `date` type stores.
 * hyparquet-writer mis-encodes Date-valued dictionary columns, so callers
 * should feed this into their row before writing a month-partitioned date.
 */
export function toIcebergDayCount(value: string | Date | number): number {
  if (typeof value === 'number')
    return value
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms))
      throw new TypeError('toIcebergDayCount: invalid Date (NaN)')
    return Math.floor(ms / DAY_MILLIS)
  }
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(ms))
    throw new TypeError(`toIcebergDayCount: invalid date string '${value}'`)
  return Math.floor(ms / DAY_MILLIS)
}
