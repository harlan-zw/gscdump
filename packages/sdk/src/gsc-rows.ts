// Shape-canonicalising helpers for GSC row payloads.
//
// Free-tier rows (GSC API) ship `position`; engine rows ship `sum_position`.
// Both formats coerce to the same denominator:
// `sum_position = (position - 1) * impressions`, so downstream
// `weightedPosition / impressions + 1` math works without branching.
// The `+1` in `position` is GSC's 1-indexed convention (position 1 == top
// result), applied once after weighting.

export interface RawDailyRow {
  date: string
  clicks: number
  impressions: number
  sum_position?: number
  position?: number
}

export interface CanonicalDailyRow {
  date: string
  clicks: number
  impressions: number
  sum_position: number
}

export interface GscRowTotals {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface GscDailySummary {
  daily: CanonicalDailyRow[]
  totals: GscRowTotals
  chartData: Array<{ date: string, clicks: number, impressions: number }>
}

/** Fill `sum_position` from `(position - 1) * impressions` when the row only carries `position`. */
export function coerceRowMetrics<
  T extends { impressions: number, sum_position?: number, position?: number },
>(row: T): T & { sum_position: number } {
  return {
    ...row,
    sum_position: row.sum_position ?? (Math.max(1, row.position ?? 0) - 1) * row.impressions,
  }
}

/** Sort daily rows by date asc, coerce `sum_position`, reduce totals, derive chartData. */
export function summarizeDailyRows(raw: readonly RawDailyRow[]): GscDailySummary {
  const daily: CanonicalDailyRow[] = raw
    .map(coerceRowMetrics)
    .map(r => ({ date: r.date, clicks: r.clicks, impressions: r.impressions, sum_position: r.sum_position }))
    .sort((a, b) => a.date.localeCompare(b.date))

  let clicks = 0
  let impressions = 0
  let weightedPosition = 0
  for (const d of daily) {
    clicks += d.clicks
    impressions += d.impressions
    weightedPosition += d.sum_position
  }
  const totals: GscRowTotals = {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions + 1 : 0,
  }
  const chartData = daily.map(d => ({ date: d.date, clicks: d.clicks, impressions: d.impressions }))
  return { daily, totals, chartData }
}

/**
 * Rollup-row position helper. `sum_position` is GSC's average-position sum
 * across impressions; dividing back out (+1 because GSC is 1-indexed) gives
 * the impression-weighted average position. Returns 0 when there were no
 * impressions so the column renders blank rather than NaN.
 */
export function positionFor(r: { impressions: number, sum_position: number }): number {
  return r.impressions > 0 ? r.sum_position / r.impressions + 1 : 0
}
