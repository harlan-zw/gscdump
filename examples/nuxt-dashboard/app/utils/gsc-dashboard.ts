export type {
  CountryRow,
  SearchAppearanceRow,
} from '../../layers/gsc/app/composables/gsc-stubs'
export { weightedAnonPct } from '@gscdump/sdk/anonymization'
export { countryName } from '@gscdump/sdk/country'
export type { GscConsoleUrlOpts } from '@gscdump/sdk/gsc-console-url'
export { gscConsoleUrl } from '@gscdump/sdk/gsc-console-url'
export { coerceRowMetrics, positionFor, summarizeDailyRows } from '@gscdump/sdk/rows'

export function computeGrowth(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0)
    return null
  return (current - previous) / previous
}
