import { MS_PER_DAY } from 'gscdump/dates'

// ISO-date `YYYY-MM-DD` that's `days` days before `at` (UTC). Used by rollup
// builders to inline a trailing-window cutoff into SQL instead of relying on
// `CURRENT_DATE`, which lives in the ICU extension and isn't available in
// every DuckDB build (notably Workers DuckDB).
// Parse an ISO `YYYY-MM-DD` date to UTC-midnight millis. Anchors trailing
// rollup windows to a data date rather than wall-clock time.
export function isoDateToUtcMs(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m)
    throw new Error(`dataEndDate must be ISO YYYY-MM-DD, got: ${iso}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function utcDateMinusDays(at: number, days: number): string {
  const d = new Date(at - days * MS_PER_DAY)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
