/**
 * Shared math helpers used across analyzers (scoring, normalization, deltas).
 */

export function clamp01(value: number): number {
  if (value < 0)
    return 0
  if (value > 1)
    return 1
  return value
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min)
    return min
  if (value > max)
    return max
  return value
}

/**
 * Percent difference of `current` vs `previous`. When previous is 0:
 * returns 100 if current > 0, else 0.
 */
export function percentDifference(current: number, previous: number): number {
  if (previous === 0)
    return current > 0 ? 100 : 0
  return ((current - previous) / previous) * 100
}

/** Safe ratio: returns 0 when denominator is 0. */
export function safeRatio(num: number, denom: number): number {
  return denom === 0 ? 0 : num / denom
}
