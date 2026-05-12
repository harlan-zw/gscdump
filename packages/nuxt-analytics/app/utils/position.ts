// Rollup-row position helper. `sum_position` is GSC's average-position sum
// across impressions; dividing back out (+1 because GSC is 1-indexed) gives
// the impression-weighted average position. Returns 0 when there were no
// impressions so the column renders blank rather than NaN.
export function positionFor(r: { impressions: number, sum_position: number }): number {
  return r.impressions > 0 ? r.sum_position / r.impressions + 1 : 0
}
