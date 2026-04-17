// Pad a daily timeseries so every date in [startDate, endDate] has at least
// one row. Missing dates get a zero-filled placeholder so consumers can
// render continuous charts without client-side date gymnastics.
//
// Handles grouped timeseries (multiple rows per date, e.g. date + device)
// by preserving every row for dates that are present and inserting a single
// placeholder for dates that are absent. For dimensioned timeseries where
// a placeholder per group is needed, pad per group upstream.

export interface PadTimeseriesOptions<T> {
  /** ISO date (YYYY-MM-DD), inclusive lower bound. */
  startDate: string
  /** ISO date (YYYY-MM-DD), inclusive upper bound. */
  endDate: string
  /**
   * Row to insert for missing dates. Defaults to `{ clicks: 0, impressions: 0, ctr: 0, position: 0 }`.
   * The `date` field is set automatically.
   */
  fill?: Omit<T, 'date'>
  /** Row-field that carries the ISO date. Defaults to `date`. */
  dateKey?: string
}

type DateRow = Record<string, unknown> & { date?: unknown }

const DEFAULT_FILL = { clicks: 0, impressions: 0, ctr: 0, position: 0 } as const

/**
 * Pad rows so every calendar day in `[startDate, endDate]` appears at least
 * once. Existing dates keep all their rows (grouped timeseries safe).
 */
export function padTimeseries<T extends DateRow = DateRow>(
  rows: readonly T[],
  options: PadTimeseriesOptions<T>,
): T[] {
  const { startDate, endDate } = options
  const dateKey = options.dateKey ?? 'date'
  const fill = options.fill ?? (DEFAULT_FILL as unknown as Omit<T, 'date'>)

  const byDate = new Map<string, T[]>()
  for (const row of rows) {
    const d = String(row[dateKey])
    const bucket = byDate.get(d)
    if (bucket)
      bucket.push(row)
    else
      byDate.set(d, [row])
  }

  const result: T[] = []
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    throw new Error(`padTimeseries: invalid date range ${startDate}..${endDate}`)

  for (let cursorMs = start.getTime(), endMs = end.getTime(); cursorMs <= endMs; cursorMs += 86_400_000) {
    const dateStr = new Date(cursorMs).toISOString().slice(0, 10)
    const existing = byDate.get(dateStr)
    if (existing)
      result.push(...existing)
    else
      result.push({ ...fill, [dateKey]: dateStr } as T)
  }
  return result
}
