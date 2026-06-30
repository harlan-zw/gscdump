export type {
  CountryRow,
  SearchAppearanceRow,
} from '../../layers/gsc/app/composables/gsc-stubs'
export type { GscConsoleUrlOpts } from '@gscdump/sdk'
export {
  coerceRowMetrics,
  countryName,
  gscConsoleUrl,
  positionFor,
  summarizeDailyRows,
  weightedAnonPct,
} from '@gscdump/sdk'

export function computeGrowth(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0)
    return null
  return (current - previous) / previous
}
