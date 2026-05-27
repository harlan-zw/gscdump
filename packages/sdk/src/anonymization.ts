// GSC anonymises queries on a per-day basis; summing query-grained rows
// undercounts page impressions by this amount. Callers render a banner when
// the trailing-28d weighted average crosses a threshold.
//
// Impression-weighted average matches what the user experiences when they
// open the dashboard — daily % alone is noisy on low-traffic days.

export interface DailyAnonInput {
  impressions: number
  anonymizedImpressionsPct: number
}

export function weightedAnonPct(days: readonly DailyAnonInput[] | null | undefined, window = 28): number | null {
  if (!days?.length)
    return null
  const trailing = days.slice(-window)
  let totalImpressions = 0
  let weighted = 0
  for (const d of trailing) {
    totalImpressions += d.impressions
    weighted += d.impressions * d.anonymizedImpressionsPct
  }
  return totalImpressions > 0 ? weighted / totalImpressions : null
}
