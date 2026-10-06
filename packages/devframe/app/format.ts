// Display rules ported from the gscdump.com dashboard (`fmtGscMetric`), so a
// number reads the same in the devtool and on gscdump.com.

import type { MetricTotals } from '../src/shared/protocol'

export type Metric = 'clicks' | 'impressions' | 'ctr' | 'position'

export const METRICS: readonly { key: Metric, label: string }[] = [
  { key: 'clicks', label: 'Clicks' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'ctr', label: 'CTR' },
  { key: 'position', label: 'Position' },
]

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en-US')

export function formatMetric(value: number | null, metric: Metric, mode: 'full' | 'compact' = 'full'): string {
  if (value == null)
    return '-'
  if (metric === 'ctr')
    return `${(value * 100).toFixed(1)}%`
  if (metric === 'position')
    return value.toFixed(1)
  return mode === 'compact' && value >= 10_000 ? compact.format(value) : whole.format(Math.round(value))
}

export type Delta
  = | { _tag: 'None' }
    | { _tag: 'Change', text: string, direction: 'up' | 'down' | 'flat', good: boolean | null }

/**
 * The change against the previous window. Clicks and impressions change by a
 * percentage, CTR by percentage points, and position by places, where a lower
 * position is better.
 */
export function metricDelta(metric: Metric, current: MetricTotals, previous: MetricTotals | null): Delta {
  if (!previous)
    return { _tag: 'None' }
  const now = current[metric]
  const before = previous[metric]
  if (now == null || before == null)
    return { _tag: 'None' }
  const diff = now - before
  const direction = Math.abs(diff) < 1e-9 ? 'flat' : diff > 0 ? 'up' : 'down'
  const improved = metric === 'position' ? diff < 0 : diff > 0
  const good = direction === 'flat' ? null : improved
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : ''
  if (metric === 'ctr')
    return { _tag: 'Change', text: `${sign}${Math.abs(diff * 100).toFixed(1)} pts`, direction, good }
  if (metric === 'position')
    return { _tag: 'Change', text: `${sign}${Math.abs(diff).toFixed(1)}`, direction, good }
  if (before === 0)
    return now === 0 ? { _tag: 'Change', text: '0%', direction: 'flat', good: null } : { _tag: 'Change', text: 'New', direction: 'up', good: true }
  return { _tag: 'Change', text: `${sign}${Math.abs((diff / before) * 100).toFixed(0)}%`, direction, good }
}

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const longFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export function formatDay(date: string, withYear = false): string {
  const time = Date.parse(`${date}T00:00:00Z`)
  return Number.isNaN(time) ? date : (withYear ? longFormat : dayFormat).format(time)
}
