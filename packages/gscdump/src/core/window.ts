import { addDays, countDays, toIsoDate } from './gsc-dates'

export type WindowPreset
  = | 'last-7d'
    | 'last-28d'
    | 'last-30d'
    | 'last-90d'
    | 'last-180d'
    | 'last-365d'
    | 'mtd'
    | 'qtd'
    | 'ytd'
    | 'last-quarter'
    | 'custom'

/**
 * `yoy` shifts the window back 364 days (52 weeks), so each day compares
 * against the same weekday one year earlier. Search traffic has a strong
 * weekly cycle, so a 365-day shift would compare Mondays with Sundays.
 */
export type ComparisonMode = 'none' | 'prev-period' | 'yoy'

/** Days `yoy` shifts a window back: 52 whole weeks. */
export const YOY_SHIFT_DAYS = 364

/**
 * `anchor` is the last day the window may include: the newest complete date
 * in the data, never the wall clock. Callers pass the Store's newest synced
 * date, or `getLatestGscDate()` for live reads. Custom windows take explicit
 * bounds and need no anchor.
 */
export type ResolveWindowOptions
  = | {
    preset: Exclude<WindowPreset, 'custom'>
    anchor: string
    comparison?: ComparisonMode
  }
  | {
    preset: 'custom'
    start: string
    end: string
    comparison?: ComparisonMode
  }

export interface ResolvedWindow {
  start: string
  end: string
  days: number
  comparison?: {
    start: string
    end: string
  }
}

const ROLLING_DAYS: Partial<Record<WindowPreset, number>> = {
  'last-7d': 7,
  'last-28d': 28,
  'last-30d': 30,
  'last-90d': 90,
  'last-180d': 180,
  'last-365d': 365,
}

function presetBounds(preset: Exclude<WindowPreset, 'custom'>, anchorIso: string): { start: string, end: string } {
  const rolling = ROLLING_DAYS[preset]
  if (rolling)
    return { start: addDays(anchorIso, -(rolling - 1)), end: anchorIso }

  const anchor = new Date(`${anchorIso}T00:00:00Z`)
  const year = anchor.getUTCFullYear()
  const quarterStartMonth = Math.floor(anchor.getUTCMonth() / 3) * 3
  switch (preset) {
    case 'mtd':
      return { start: toIsoDate(new Date(Date.UTC(year, anchor.getUTCMonth(), 1))), end: anchorIso }
    case 'qtd':
      return { start: toIsoDate(new Date(Date.UTC(year, quarterStartMonth, 1))), end: anchorIso }
    case 'ytd':
      return { start: toIsoDate(new Date(Date.UTC(year, 0, 1))), end: anchorIso }
    case 'last-quarter': {
      // The newest calendar quarter that ends on or before the anchor.
      const nextQuarterStart = new Date(Date.UTC(year, quarterStartMonth + 3, 1))
      const endsOnAnchor = addDays(toIsoDate(nextQuarterStart), -1) === anchorIso
      const startMonth = endsOnAnchor ? quarterStartMonth : quarterStartMonth - 3
      return {
        start: toIsoDate(new Date(Date.UTC(year, startMonth, 1))),
        end: addDays(toIsoDate(new Date(Date.UTC(year, startMonth + 3, 1))), -1),
      }
    }
    default:
      throw new Error(`resolveWindow: unknown preset ${preset}`)
  }
}

/** Pure: the same options always resolve to the same window. */
export function resolveWindow(opts: ResolveWindowOptions): ResolvedWindow {
  let start: string
  let end: string
  if (opts.preset === 'custom') {
    if (!opts.start || !opts.end)
      throw new Error('resolveWindow: preset=custom requires start and end')
    start = opts.start
    end = opts.end
  }
  else {
    if (!opts.anchor)
      throw new Error(`resolveWindow: preset=${opts.preset} requires an anchor date`)
    const bounds = presetBounds(opts.preset, opts.anchor)
    start = bounds.start
    end = bounds.end
  }

  const days = countDays(start, end)
  const result: ResolvedWindow = { start, end, days }

  if (opts.comparison === 'prev-period') {
    const previousEnd = addDays(start, -1)
    result.comparison = {
      start: addDays(previousEnd, -(days - 1)),
      end: previousEnd,
    }
  }
  else if (opts.comparison === 'yoy') {
    result.comparison = {
      start: addDays(start, -YOY_SHIFT_DAYS),
      end: addDays(end, -YOY_SHIFT_DAYS),
    }
  }

  return result
}
