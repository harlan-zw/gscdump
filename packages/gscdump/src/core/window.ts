import { addDays, countDays, toIsoDate } from './gsc-dates'

export type WindowPreset
  = | 'last-7d'
    | 'last-28d'
    | 'last-30d'
    | 'last-90d'
    | 'last-180d'
    | 'last-365d'
    | 'mtd'
    | 'ytd'
    | 'custom'

export type ComparisonMode = 'none' | 'prev-period' | 'yoy'

export interface ResolveWindowOptions {
  preset: WindowPreset
  comparison?: ComparisonMode
  anchor?: string
  start?: string
  end?: string
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

export function resolveWindow(opts: ResolveWindowOptions): ResolvedWindow {
  const anchor = opts.anchor ? new Date(`${opts.anchor}T00:00:00Z`) : new Date()
  const anchorIso = toIsoDate(anchor)

  let start: string
  let end: string

  switch (opts.preset) {
    case 'last-7d':
      end = anchorIso
      start = addDays(anchorIso, -6)
      break
    case 'last-28d':
      end = anchorIso
      start = addDays(anchorIso, -27)
      break
    case 'last-30d':
      end = anchorIso
      start = addDays(anchorIso, -29)
      break
    case 'last-90d':
      end = anchorIso
      start = addDays(anchorIso, -89)
      break
    case 'last-180d':
      end = anchorIso
      start = addDays(anchorIso, -179)
      break
    case 'last-365d':
      end = anchorIso
      start = addDays(anchorIso, -364)
      break
    case 'mtd':
      end = anchorIso
      start = toIsoDate(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)))
      break
    case 'ytd':
      end = anchorIso
      start = toIsoDate(new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1)))
      break
    case 'custom':
      if (!opts.start || !opts.end)
        throw new Error('resolveWindow: preset=custom requires start and end')
      start = opts.start
      end = opts.end
      break
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
      start: addDays(start, -365),
      end: addDays(end, -365),
    }
  }

  return result
}
