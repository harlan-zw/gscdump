/**
 * Formats a date for GSC API queries (YYYY-MM-DD format).
 * @param d - Date object, date string, or null/undefined
 * @returns Formatted date string or null/undefined if input is falsy
 */
export function formatDateGsc(d?: Date | string | null): string | null | undefined {
  if (!d)
    return d as null | undefined
  if (typeof d === 'string')
    return d
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
}

/**
 * Calculates the percentage difference between two values.
 * Returns 0 if either value is null, undefined, or 0 (no meaningful comparison).
 * @param a - Current value
 * @param b - Previous/comparison value
 * @returns Percentage difference (positive = increase, negative = decrease), or 0 if either value is falsy
 */
export function percentDifference(a?: number | null, b?: number | null): number {
  if (!b || !a)
    return 0
  return ((a - b) / ((a + b) / 2)) * 100
}
