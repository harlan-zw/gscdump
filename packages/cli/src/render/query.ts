import type { OutputOptions } from './layout'
import { parseGscSiteUrl } from 'gscdump'
import { columnsFor } from './analysis'
import { barColumn } from './charts'
import { renderTable, textLines } from './layout'

export function renderQuery(input: {
  site: string
  dimensions: string[]
  start: string
  end: string
  rows: Record<string, unknown>[]
}, options: OutputOptions): string {
  const columns = columnsFor(input.rows, [...input.dimensions, 'clicks', 'impressions', 'ctr', 'position'])
  if (input.dimensions.length === 1 && ['page', 'query', 'country', 'device', 'date'].includes(input.dimensions[0])) {
    const clicks = columns.findIndex(column => column.key === 'clicks')
    if (clicks !== -1)
      columns[clicks] = barColumn(input.rows, 'clicks', options)
  }
  return [
    ...textLines(`${parseGscSiteUrl(input.site).hostname} / query`, options, 'accent'),
    ...textLines(`${input.start} to ${input.end}`, options, 'muted'),
    '',
    ...renderTable(input.rows, columns, options),
  ].join('\n')
}
