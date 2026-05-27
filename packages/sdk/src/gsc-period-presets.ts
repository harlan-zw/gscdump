// Period + compare-mode presets used by date-range pickers. Pure data —
// icons are string slugs (Lucide naming convention) consumed by the host UI.

import type { CompareMode, Period } from './period'

export type GscColumn = 'clicks' | 'impressions' | 'ctr' | 'position'

export interface GscColumnOption {
  key: GscColumn
  label: string
  icon: string
  color: string
}

export interface PeriodPreset {
  value: Period
  label: string
  shortLabel: string
  group: 'rolling' | 'calendar'
}

export const PERIOD_PRESETS: PeriodPreset[] = [
  { value: '7d', label: 'Last 7 days', shortLabel: '7d', group: 'rolling' },
  { value: '28d', label: 'Last 28 days', shortLabel: '28d', group: 'rolling' },
  { value: '3m', label: 'Last 3 months', shortLabel: '3m', group: 'rolling' },
  { value: '6m', label: 'Last 6 months', shortLabel: '6m', group: 'rolling' },
  { value: '12m', label: 'Last 12 months', shortLabel: '12m', group: 'rolling' },
  { value: 'this-week', label: 'This week', shortLabel: 'Week', group: 'calendar' },
  { value: 'this-month', label: 'This month', shortLabel: 'Month', group: 'calendar' },
  { value: 'last-month', label: 'Last month', shortLabel: 'Last mo', group: 'calendar' },
  { value: 'this-quarter', label: 'This quarter', shortLabel: 'Qtr', group: 'calendar' },
  { value: 'this-year', label: 'This year', shortLabel: 'Year', group: 'calendar' },
]

export const COMPARE_OPTIONS: { value: CompareMode, label: string, description: string }[] = [
  { value: 'previous', label: 'Previous period', description: 'Compare to the period immediately before' },
  { value: 'year', label: 'Year over year', description: 'Compare to the same period last year' },
  { value: 'none', label: 'No comparison', description: 'Disable comparison' },
]

export const GSC_PERIOD_OPTIONS = PERIOD_PRESETS
  .filter(p => p.group === 'rolling')
  .map(p => ({ label: p.shortLabel, value: p.value, longLabel: p.label }))

export const GSC_PERIOD_OPTIONS_LONG = GSC_PERIOD_OPTIONS.map(o => ({ label: o.longLabel, value: o.value }))

export const GSC_COLUMN_OPTIONS: GscColumnOption[] = [
  { key: 'clicks', label: 'Clicks', icon: 'i-lucide-mouse-pointer-click', color: 'blue' },
  { key: 'impressions', label: 'Views', icon: 'i-lucide-eye', color: 'purple' },
  { key: 'ctr', label: 'CTR', icon: 'i-lucide-percent', color: 'green' },
  { key: 'position', label: 'Pos', icon: 'i-lucide-hash', color: 'orange' },
]
