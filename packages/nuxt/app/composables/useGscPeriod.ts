// Period + comparison primitives. Pure utilities (date math, growth calc)
// plus the reactive `useGscPeriod()` composable that wires them into refs.
//
// Supports rolling presets (7d/28d/3m/6m/12m), calendar presets (this-week,
// this-month, last-month, this-quarter, this-year), and custom ranges
// (`custom:start:end` or `custom:start:end:prevStart:prevEnd`).
//
// Timezone via `runtimeConfig.public.analytics.timezone` (IANA name) or
// the `timezone` option. Default: UTC.

import { GSC_STABLE_LATENCY_DAYS } from '../utils/gsc-constants'

export type RollingPeriod = '7d' | '28d' | '3m' | '6m' | '12m'
export type CalendarPeriod = 'this-week' | 'this-month' | 'last-month' | 'this-quarter' | 'this-year'
export type CustomPeriod = `custom:${string}:${string}` | `custom:${string}:${string}:${string}:${string}`
export type Period = RollingPeriod | CalendarPeriod | CustomPeriod
export type CompareMode = 'previous' | 'year' | 'none'

export interface PeriodPreset {
  value: RollingPeriod | CalendarPeriod
  label: string
  shortLabel: string
  days: number
}

export const PERIOD_PRESETS = [
  { value: '7d', label: 'Last 7 days', shortLabel: '7d', days: 7 },
  { value: '28d', label: 'Last 28 days', shortLabel: '28d', days: 28 },
  { value: '3m', label: 'Last 3 months', shortLabel: '3m', days: 90 },
  { value: '6m', label: 'Last 6 months', shortLabel: '6m', days: 180 },
  { value: '12m', label: 'Last 12 months', shortLabel: '12m', days: 365 },
  { value: 'this-week', label: 'This week', shortLabel: 'WTD', days: 7 },
  { value: 'this-month', label: 'This month', shortLabel: 'MTD', days: 31 },
  { value: 'last-month', label: 'Last month', shortLabel: 'LM', days: 31 },
  { value: 'this-quarter', label: 'This quarter', shortLabel: 'QTD', days: 92 },
  { value: 'this-year', label: 'This year', shortLabel: 'YTD', days: 365 },
] as const satisfies readonly PeriodPreset[]

export const COMPARE_OPTIONS: readonly { value: CompareMode, label: string }[] = [
  { value: 'previous', label: 'Previous period' },
  { value: 'year', label: 'Year over year' },
  { value: 'none', label: 'No comparison' },
]

export interface DateRange {
  start: string
  end: string
  days: number
  prevStart: string
  prevEnd: string
  yearStart: string
  yearEnd: string
}

export function isCustomPeriod(p: Period | string): p is CustomPeriod {
  return typeof p === 'string' && p.startsWith('custom:')
}

export function parseCustomPeriod(p: Period | string): { start: string, end: string, prevStart?: string, prevEnd?: string } | null {
  if (!isCustomPeriod(p))
    return null
  const [, start, end, prevStart, prevEnd] = p.split(':')
  if (!start || !end)
    return null
  return prevStart && prevEnd ? { start, end, prevStart, prevEnd } : { start, end }
}

export interface PeriodOptions {
  /** Subtract GSC's stable-data latency from `end`. Default `true`. */
  stableData?: boolean
  /** IANA timezone (e.g. 'America/Los_Angeles'). Default UTC. */
  timezone?: string
}

export function periodToDateRange(period: Period | string, opts: PeriodOptions = {}): DateRange {
  const stableData = opts.stableData ?? true
  const custom = parseCustomPeriod(period)
  if (custom) {
    const range = buildRange(parseIso(custom.start), parseIso(custom.end))
    if (custom.prevStart && custom.prevEnd) {
      return {
        ...range,
        prevStart: custom.prevStart,
        prevEnd: custom.prevEnd,
        yearStart: custom.prevStart,
        yearEnd: custom.prevEnd,
      }
    }
    return range
  }

  const today = todayInTz(opts.timezone)
  const end = stableData ? addDays(today, -GSC_STABLE_LATENCY_DAYS) : addDays(today, -1)

  switch (period) {
    case '7d': return buildRange(addDays(end, -6), end)
    case '28d': return buildRange(addDays(end, -27), end)
    case '3m': return buildRange(addDays(end, -89), end)
    case '6m': return buildRange(addDays(end, -179), end)
    case '12m': return buildRange(addDays(end, -364), end)
    case 'this-week': return buildRange(startOfWeek(end), end)
    case 'this-month': return buildRange(startOfMonth(end), end)
    case 'last-month': {
      const prev = addDays(startOfMonth(end), -1)
      return buildRange(startOfMonth(prev), endOfMonth(prev))
    }
    case 'this-quarter': return buildRange(startOfQuarter(end), end)
    case 'this-year': return buildRange(startOfYear(end), end)
    default: return buildRange(addDays(end, -27), end)
  }
}

export function periodToDays(period: Period | string, opts?: PeriodOptions): number {
  return periodToDateRange(period, opts).days
}

export function compareRange(range: DateRange, mode: CompareMode): { start: string, end: string } | null {
  if (mode === 'none')
    return null
  if (mode === 'year')
    return { start: range.yearStart, end: range.yearEnd }
  return { start: range.prevStart, end: range.prevEnd }
}

export function getPeriodLabel(period: Period | string): string {
  if (isCustomPeriod(period)) {
    const c = parseCustomPeriod(period)
    return c ? `${c.start} → ${c.end}` : 'Custom'
  }
  return PERIOD_PRESETS.find(p => p.value === period)?.label ?? String(period)
}

/**
 * Relative growth as a fraction (0.12 = +12%). `null` if prev is zero or
 * either side missing — caller renders "—" rather than divide-by-zero.
 */
export function computeGrowth(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0)
    return null
  return (current - previous) / previous
}

export interface UseGscPeriodOptions {
  defaultPeriod?: Period
  defaultCompareMode?: CompareMode
  defaultStableData?: boolean
  /** Override `runtimeConfig.public.analytics.timezone`. */
  timezone?: string
}

export interface UseGscPeriodReturn {
  period: Ref<Period>
  compareMode: Ref<CompareMode>
  stableData: Ref<boolean>
  range: ComputedRef<DateRange>
  comparison: ComputedRef<{ start: string, end: string } | null>
  label: ComputedRef<string>
  presets: typeof PERIOD_PRESETS
  compareOptions: typeof COMPARE_OPTIONS
}

export function useGscPeriod(opts: UseGscPeriodOptions = {}): UseGscPeriodReturn {
  const period = useState<Period>('gsc:period', () => opts.defaultPeriod ?? '28d')
  const compareMode = useState<CompareMode>('gsc:compareMode', () => opts.defaultCompareMode ?? 'previous')
  const stableData = useState<boolean>('gsc:stableData', () => opts.defaultStableData ?? true)

  const cfg = useRuntimeConfig().public.analytics as { timezone?: string } | undefined
  const timezone = opts.timezone ?? cfg?.timezone ?? undefined

  const range = computed(() => periodToDateRange(period.value, { stableData: stableData.value, timezone }))
  const comparison = computed(() => compareRange(range.value, compareMode.value))
  const label = computed(() => getPeriodLabel(period.value))

  return {
    period,
    compareMode,
    stableData,
    range,
    comparison,
    label,
    presets: PERIOD_PRESETS,
    compareOptions: COMPARE_OPTIONS,
  }
}

function todayInTz(tz?: string): Date {
  if (!tz) {
    const now = new Date()
    return new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  }
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  return new Date(`${fmt.format(new Date())}T00:00:00Z`)
}

function parseIso(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function startOfWeek(d: Date): Date {
  const day = d.getUTCDay()
  return addDays(d, day === 0 ? -6 : 1 - day)
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
}

function startOfQuarter(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1))
}

function startOfYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
}

function buildRange(start: Date, end: Date): DateRange {
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  const prevEnd = addDays(start, -1)
  const prevStart = addDays(prevEnd, -(days - 1))
  return {
    start: iso(start),
    end: iso(end),
    days,
    prevStart: iso(prevStart),
    prevEnd: iso(prevEnd),
    yearStart: iso(addDays(start, -365)),
    yearEnd: iso(addDays(end, -365)),
  }
}
