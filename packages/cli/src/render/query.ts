import type { OutputOptions } from './layout'
import { parseGscSiteUrl } from 'gscdump'
import { columnsFor, rowLabel } from './analysis'
import { renderBars, renderSparklines } from './charts'
import { renderTable, textLines } from './layout'
import { finite } from './metrics'

export function renderQuery(input: {
  site: string
  dimensions: string[]
  start: string
  end: string
  rows: Record<string, unknown>[]
}, options: OutputOptions): string {
  const lines = [
    ...textLines('gscdump / query', options, 'accent'),
    ...textLines(`Site: ${parseGscSiteUrl(input.site).hostname}`, options),
    ...textLines(`${input.start} to ${input.end}`, options, 'muted'),
    '',
  ]
  if (input.dimensions.length === 1 && input.dimensions[0] === 'date' && input.rows.length) {
    const known = input.rows.every(row => finite(row.clicks) !== null)
    lines.push(...renderSparklines([{
      label: 'Returned rows',
      total: known ? input.rows.reduce((sum, row) => sum + (row.clicks as number), 0) : null,
      points: input.rows.map(row => ({ date: String(row.date), value: finite(row.clicks) })),
    }], { start: input.start, end: input.end, unit: 'day' }, 'clicks', options), '')
  }
  else if (input.dimensions.length === 1 && ['page', 'query', 'country', 'device'].includes(input.dimensions[0]) && input.rows.length) {
    const top = [...input.rows].sort((a, b) => (finite(b.clicks) ?? 0) - (finite(a.clicks) ?? 0)).slice(0, 5)
    lines.push(...textLines(`Clicks: top ${top.length} returned rows`, options), ...renderBars(top.map(row => ({ label: rowLabel(row), value: finite(row.clicks) })), 'clicks', options), '')
  }
  lines.push(...renderTable(input.rows, columnsFor(input.rows, [...input.dimensions, 'clicks', 'impressions', 'ctr', 'position']), options))
  lines.push('', ...textLines(`${input.rows.length} returned rows. Totals cover these rows only.`, options, 'muted'))
  return lines.join('\n')
}
