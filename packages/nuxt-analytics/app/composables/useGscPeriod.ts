// Period + comparison primitives. Pure utilities (date math, growth calc)
// plus the reactive `useGscPeriod()` composable that wires them into refs.
//
// Consumers build their own styled picker components — nuxtseo.com's
// ProDateRangePicker vs. a native-select in the gscdump example — and share
// this single source of truth for what a "period" resolves to.
//
// Not ported from nuxtseo.com verbatim: this version drops calendar presets
// (this-month, this-quarter, …) and custom ranges. Those land alongside a
// consumer that actually needs them. PST anchoring is also dropped — we use
// UTC-today minus the GSC stable-data latency, which is close enough until
// a consumer proves otherwise.

export type Period = '7d' | '28d' | '3m' | '6m' | '12m'
export type CompareMode = 'previous' | 'year' | 'none'

export interface PeriodPreset {
  value: Period
  label: string
  shortLabel: string
  /** Number of days the window covers. */
  days: number
}

export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  { value: '7d', label: 'Last 7 days', shortLabel: '7d', days: 7 },
  { value: '28d', label: 'Last 28 days', shortLabel: '28d', days: 28 },
  { value: '3m', label: 'Last 3 months', shortLabel: '3m', days: 90 },
  { value: '6m', label: 'Last 6 months', shortLabel: '6m', days: 180 },
  { value: '12m', label: 'Last 12 months', shortLabel: '12m', days: 365 },
]

export const COMPARE_OPTIONS: readonly { value: CompareMode, label: string }[] = [
  { value: 'previous', label: 'Previous period' },
  { value: 'year', label: 'Year over year' },
  { value: 'none', label: 'No comparison' },
]

export interface DateRange {
  /** ISO date `YYYY-MM-DD` inclusive. */
  start: string
  end: string
  days: number
  /** Comparison range (immediately prior window). */
  prevStart: string
  prevEnd: string
  /** Year-over-year comparison (same calendar dates, one year earlier). */
  yearStart: string
  yearEnd: string
}

export function periodToDateRange(period: Period, stableData = true): DateRange {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const end = addDays(today, stableData ? -GSC_STABLE_LATENCY_DAYS : -1)
  const preset = PERIOD_PRESETS.find(p => p.value === period) ?? PERIOD_PRESETS[1]!
  const start = addDays(end, -(preset.days - 1))
  const prevEnd = addDays(start, -1)
  const prevStart = addDays(prevEnd, -(preset.days - 1))
  const yearStart = addDays(start, -365)
  const yearEnd = addDays(end, -365)
  return {
    start: iso(start),
    end: iso(end),
    days: preset.days,
    prevStart: iso(prevStart),
    prevEnd: iso(prevEnd),
    yearStart: iso(yearStart),
    yearEnd: iso(yearEnd),
  }
}

export function getPeriodLabel(period: Period): string {
  return PERIOD_PRESETS.find(p => p.value === period)?.label ?? period
}

/**
 * Relative growth as a fraction (0.12 = +12%). `null` if prev is zero or
 * either side missing — the caller renders "—" rather than a divide-by-zero.
 */
export function computeGrowth(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0)
    return null
  return (current - previous) / previous
}

export interface UseGscPeriodOptions {
  /** Initial period. Default `'28d'`. */
  defaultPeriod?: Period
  /** Initial compare mode. Default `'previous'`. */
  defaultCompareMode?: CompareMode
  /** Subtract GSC's stable-data latency from `end`. Default `true`. */
  defaultStableData?: boolean
}

export interface UseGscPeriodReturn {
  period: Ref<Period>
  compareMode: Ref<CompareMode>
  stableData: Ref<boolean>
  /** Resolved date range reactively derived from the above. */
  range: ComputedRef<DateRange>
  /** Label for the current period (e.g. "Last 28 days"). */
  label: ComputedRef<string>
  presets: typeof PERIOD_PRESETS
  compareOptions: typeof COMPARE_OPTIONS
}

/**
 * Reactive period + comparison state. One source of truth for date ranges
 * across a page — `<GscDateRangePicker v-model:period v-model:compare-mode
 * v-model:stable-data>` pairs directly with the refs it returns.
 */
export function useGscPeriod(opts: UseGscPeriodOptions = {}): UseGscPeriodReturn {
  const period = ref<Period>(opts.defaultPeriod ?? '28d')
  const compareMode = ref<CompareMode>(opts.defaultCompareMode ?? 'previous')
  const stableData = ref<boolean>(opts.defaultStableData ?? true)

  const range = computed(() => periodToDateRange(period.value, stableData.value))
  const label = computed(() => getPeriodLabel(period.value))

  return {
    period,
    compareMode,
    stableData,
    range,
    label,
    presets: PERIOD_PRESETS,
    compareOptions: COMPARE_OPTIONS,
  }
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
