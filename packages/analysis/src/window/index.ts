/**
 * Date window resolution for analytics queries.
 *
 * Dialect-agnostic: no database dependency. Shared between /browser
 * (DuckDB-WASM) and /sqlite (D1) subpaths.
 *
 * Presets anchor to a given date (default today) and produce a canonical
 * [start, end] inclusive range as YYYY-MM-DD strings. Comparison windows
 * produce a second equally-sized range immediately preceding the primary
 * window (`prev-period`) or 365 days earlier (`yoy`).
 */

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

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function parseIso(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

function daysBetween(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / 86400000) + 1
}

export function resolveWindow(opts: ResolveWindowOptions): ResolvedWindow {
  const anchor = opts.anchor ? parseIso(opts.anchor) : new Date()
  const anchorIso = toIso(anchor)

  let start: string
  let end: string

  switch (opts.preset) {
    case 'last-7d':
      end = anchorIso
      start = toIso(addDays(anchor, -6))
      break
    case 'last-28d':
      end = anchorIso
      start = toIso(addDays(anchor, -27))
      break
    case 'last-30d':
      end = anchorIso
      start = toIso(addDays(anchor, -29))
      break
    case 'last-90d':
      end = anchorIso
      start = toIso(addDays(anchor, -89))
      break
    case 'last-180d':
      end = anchorIso
      start = toIso(addDays(anchor, -179))
      break
    case 'last-365d':
      end = anchorIso
      start = toIso(addDays(anchor, -364))
      break
    case 'mtd':
      end = anchorIso
      start = toIso(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)))
      break
    case 'ytd':
      end = anchorIso
      start = toIso(new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1)))
      break
    case 'custom':
      if (!opts.start || !opts.end)
        throw new Error('resolveWindow: preset=custom requires start and end')
      start = opts.start
      end = opts.end
      break
  }

  const days = daysBetween(start, end)
  const result: ResolvedWindow = { start, end, days }

  const mode = opts.comparison ?? 'none'
  if (mode === 'prev-period') {
    const prevEnd = toIso(addDays(parseIso(start), -1))
    const prevStart = toIso(addDays(parseIso(prevEnd), -(days - 1)))
    result.comparison = { start: prevStart, end: prevEnd }
  }
  else if (mode === 'yoy') {
    const prevEnd = toIso(addDays(parseIso(end), -365))
    const prevStart = toIso(addDays(parseIso(start), -365))
    result.comparison = { start: prevStart, end: prevEnd }
  }

  return result
}
