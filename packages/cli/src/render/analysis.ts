import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { OutputOptions, TableColumn } from './layout'
import { parseGscSiteUrl } from 'gscdump'
import { barColumn, calendarBuckets, renderBars, renderShare, renderSparklines } from './charts'
import { renderTable, textLines } from './layout'
import { finite, formatMetric, metricLabel } from './metrics'

export interface AnalysisDisplayContext {
  id: string
  site: string
  start: string
  end: string
  previous?: { start: string, end: string }
  metric?: 'clicks' | 'impressions'
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function rowLabel(row: Record<string, unknown>): string {
  const query = row.query ?? row.keyword
  const page = row.page ?? row.url
  return query != null && page != null ? `${query} (${page})` : String(query ?? page ?? row.country ?? row.device ?? row.month ?? row.date ?? 'n/a')
}

export function columnsFor(rows: readonly Record<string, unknown>[], keys?: readonly string[]): TableColumn[] {
  const fields = keys ?? [...new Set(rows.flatMap(row => Object.keys(row)))]
  return fields.filter(key => rows.some(row => key in row)).map(key => ({
    key,
    label: metricLabel(key),
    numeric: rows.some(row => typeof row[key] === 'number'),
    format: (value: unknown) => {
      if (value == null)
        return 'n/a'
      if (typeof value === 'number')
        return formatMetric(key, value)
      if (Array.isArray(value))
        return `[${value.length} items]`
      if (typeof value === 'object')
        return JSON.stringify(value)
      return String(value)
    },
  }))
}

export function renderAnalysis(result: AnalysisResult, context: AnalysisDisplayContext, options: OutputOptions): string {
  const rows = result.results
  const meta = result.meta
  const start = typeof meta.startDate === 'string' ? meta.startDate : context.start
  const end = typeof meta.endDate === 'string' ? meta.endDate : context.end
  const lines = [
    ...textLines(`${parseGscSiteUrl(context.site).hostname} / ${context.id}`, options, 'accent'),
    ...textLines(`${start} to ${end}`, options, 'muted'),
  ]
  if (context.previous)
    lines.push(...textLines(`vs ${context.previous.start} to ${context.previous.end}`, options, 'muted'))
  lines.push('')
  if (!rows.length) {
    lines.push(...textLines('No results for this period.', options))
    return lines.join('\n')
  }
  if (context.id === 'brand') {
    const summary = asRecord(meta.summary)
    lines.push(...textLines('Click share', options), ...renderShare([
      { label: 'Brand', value: finite(summary.brandClicks) },
      { label: 'Non-brand', value: finite(summary.nonBrandClicks) },
    ], 'clicks', options), '')
  }
  if (context.id === 'trends') {
    const series = rows.map(row => ({
      ...row,
      label: rowLabel(row),
      total: finite(row.totalClicks),
      points: (Array.isArray(row.series) ? row.series : []).map((point) => {
        const value = asRecord(point)
        return { date: String(value.week), value: finite(value.clicks) }
      }),
    }))
    lines.push(...renderSparklines(series, { start, end, unit: 'week' }, 'clicks', options, columnsFor(rows, ['avgPosition'])))
  }
  else if (context.id === 'movers') {
    const displayed = rows.map(row => ({ ...row, entity: rowLabel(row) }))
    lines.push(...renderTable(displayed, [
      { key: 'entity', label: '' },
      ...columnsFor(rows, ['baselineClicks', 'recentClicks']),
      barColumn(rows, 'clicksChange', options, true),
    ], options))
  }
  else if (context.id === 'seasonality') {
    const months = calendarBuckets(start, end, 'month')
    const values = new Map(rows.map(row => [String(row.month), finite(row.value)]))
    const partial = new Set<string>()
    if (!start.endsWith('-01'))
      partial.add(start.slice(0, 7))
    if (new Date(`${end}T00:00:00Z`).getUTCDate() !== new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).getUTCDate())
      partial.add(end.slice(0, 7))
    lines.push(...textLines(`Monthly ${context.metric ?? 'clicks'}`, options))
    lines.push(...renderBars(months.map(month => ({ label: `${month}${partial.has(month) ? '*' : ''}`, value: values.get(month) ?? null })), context.metric ?? 'clicks', options))
    if (meta.insufficientData === true || values.size < 12)
      lines.push(...textLines(`! ${values.size} of 12 months`, options, 'warning'))
    if (months.some(month => partial.has(month)))
      lines.push(...textLines('* partial month', options, 'muted'))
  }
  else {
    lines.push(...renderTable(rows, columnsFor(rows), options))
  }
  const total = finite(meta.total)
  if (total !== null && total > rows.length)
    lines.push('', ...textLines(`${rows.length} of ${formatMetric('clicks', total)} rows`, options, 'muted'))
  return lines.join('\n')
}
