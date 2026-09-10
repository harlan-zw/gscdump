import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { OutputOptions, TableColumn } from './layout'
import { parseGscSiteUrl } from 'gscdump'
import { calendarBuckets, renderBars, renderShare, renderSparklines } from './charts'
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
    ...textLines(`gscdump / ${context.id}`, options, 'accent'),
    ...textLines(`Site: ${parseGscSiteUrl(context.site).hostname}`, options),
    ...textLines(`${start} to ${end}`, options, 'muted'),
  ]
  if (context.previous)
    lines.push(...textLines(`Previous: ${context.previous.start} to ${context.previous.end}`, options, 'muted'))
  lines.push('')
  if (!rows.length) {
    lines.push(...textLines('No results for this period.', options))
    return lines.join('\n')
  }
  if (context.id === 'brand') {
    const summary = asRecord(meta.summary)
    lines.push(...textLines('Click share, returned rows', options), ...renderShare([
      { label: 'Brand', value: finite(summary.brandClicks) },
      { label: 'Non-brand', value: finite(summary.nonBrandClicks) },
    ], 'clicks', options), '')
  }
  if (context.id === 'trends') {
    const series = rows.map(row => ({
      label: rowLabel(row),
      total: finite(row.totalClicks),
      points: (Array.isArray(row.series) ? row.series : []).map((point) => {
        const value = asRecord(point)
        return { date: String(value.week), value: finite(value.clicks) }
      }),
    }))
    lines.push(...renderSparklines(series, { start, end, unit: 'week' }, 'clicks', options), '')
    lines.push(...textLines('Growth compares the latter and earlier series halves.', options, 'muted'))
    lines.push(...renderTable(rows, columnsFor(rows, ['page', 'query', 'growthRatio', 'avgPosition', 'trend']), options))
  }
  else if (context.id === 'movers') {
    lines.push(...textLines('Click change', options), ...renderBars(rows.map(row => ({ label: rowLabel(row), value: finite(row.clicksChange) })), 'clicks', options, true), '')
    lines.push(...renderTable(rows, columnsFor(rows, ['keyword', 'query', 'page', 'recentClicks', 'baselineClicks', 'ctr', 'position']), options))
    if (rows.some(row => Array.isArray(row.series) && row.series.length > 0)) {
      const series = rows.map((row) => {
        const points = (Array.isArray(row.series) ? row.series : []).map((point) => {
          const value = asRecord(point)
          return { date: String(value.week), value: finite(value.clicks) }
        })
        return {
          label: rowLabel(row),
          total: points.length && points.every(point => point.value !== null) ? points.reduce((sum, point) => sum + point.value!, 0) : null,
          points,
        }
      })
      lines.push('', ...textLines('Weekly clicks across both periods', options))
      lines.push(...renderSparklines(series, { start: context.previous?.start ?? start, end, unit: 'week' }, 'clicks', options))
    }
    else {
      lines.push(...textLines('Weekly data unavailable.', options, 'muted'))
    }
    for (const row of rows.filter(row => row.baselineClicks === 0))
      lines.push(...textLines(`${rowLabel(row)}: previous clicks: 0. Percentage change unavailable.`, options, 'muted'))
  }
  else if (context.id === 'seasonality') {
    const months = calendarBuckets(start, end, 'month')
    const values = new Map(rows.map(row => [String(row.month), finite(row.value)]))
    lines.push(...textLines(`Monthly ${context.metric ?? 'clicks'}`, options))
    lines.push(...renderBars(months.map(month => ({ label: month, value: values.get(month) ?? null })), context.metric ?? 'clicks', options))
    if (meta.insufficientData === true || values.size < 12)
      lines.push(...textLines('! Fewer than 12 months available.', options, 'warning'))
    if (!start.endsWith('-01') || new Date(`${end}T00:00:00Z`).getUTCDate() !== new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).getUTCDate())
      lines.push(...textLines('! The selected range includes a partial month.', options, 'warning'))
  }
  else {
    lines.push(...renderTable(rows, columnsFor(rows), options))
  }
  const total = finite(meta.total)
  lines.push('', ...textLines(total !== null && total > rows.length
    ? `Showing ${rows.length} of ${formatMetric('clicks', total)} results.`
    : `${formatMetric('clicks', rows.length)} returned rows.`, options, 'muted'))
  return lines.join('\n')
}
