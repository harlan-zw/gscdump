import type { OutputOptions, TableColumn } from './layout'
import { contentWidth, fitLabel, pad, paint, renderTable, textLines } from './layout'
import { finite, formatChange, formatMetric, metricLabel, signed } from './metrics'

export function barColumn(rows: readonly Record<string, unknown>[], key: string, options: OutputOptions, diverging = false): TableColumn {
  const max = rows.reduce((largest, row) => Math.max(largest, Math.abs(finite(row[key]) ?? 0)), 0)
  const width = options.columns >= 110 ? 12 : options.columns >= 70 ? 8 : 4
  const numberWidth = rows.reduce((largest, row) => {
    const value = finite(row[key])
    return Math.max(largest, (value === null ? 'n/a' : diverging ? signed(value) : formatMetric(key, value)).length)
  }, 0)
  return {
    key,
    label: diverging ? 'Change' : metricLabel(key),
    numeric: true,
    format: (value) => {
      const n = finite(value)
      if (n === null || (!diverging && n < 0))
        return 'n/a'
      const size = max === 0 ? 0 : Math.round(Math.abs(n) / max * width)
      const fill = (options.unicode ? '█' : '#').repeat(size)
      const mark = diverging
        ? `${(n < 0 ? fill : '').padStart(width)}${options.unicode ? '│' : '|'}${(n > 0 ? fill : '').padEnd(width)}`
        : fill.padEnd(width)
      return `${mark} ${pad(diverging ? signed(n) : formatMetric(key, n), numberWidth, true)}`
    },
    tone: value => diverging ? (finite(value) ?? 0) < 0 ? 'bad' : (finite(value) ?? 0) > 0 ? 'good' : 'neutral' : 'accent',
  }
}

export interface BarRow {
  label: string
  value: number | null
}

/** Ranked and chronological bars share a zero baseline. Callers own ordering. */
export function renderBars(rows: readonly BarRow[], metric: string, options: OutputOptions, diverging = false): string[] {
  if (!rows.length)
    return textLines('No results for this period.', options)
  const width = contentWidth(options)
  const max = rows.reduce((largest, row) => Math.max(largest, Math.abs(finite(row.value) ?? 0)), 0)
  const barWidth = Math.max(1, Math.min(28, width - 16))
  const half = Math.max(1, Math.floor(barWidth / 2))
  const fill = options.unicode ? '█' : '#'
  const axis = options.unicode ? '│' : '|'
  const lines: string[] = []
  for (const row of rows) {
    const value = finite(row.value)
    const label = fitLabel(row.label, width >= 64 ? 24 : width, options)
    const valid = value !== null && (diverging || value >= 0)
    const number = valid ? diverging ? signed(value) : formatMetric(metric, value) : 'n/a'
    if (width < 30) {
      lines.push(...textLines(`${row.label}: ${number}`, options))
      continue
    }
    const size = !valid || max === 0 ? 0 : Math.round(Math.abs(value) / max * (diverging ? half : barWidth))
    const mark = diverging
      ? `${paint(value !== null && value < 0 ? fill.repeat(size).padStart(half) : ' '.repeat(half), 'bad', options)}${axis}${paint(value !== null && value > 0 ? fill.repeat(size).padEnd(half) : ' '.repeat(half), 'good', options)}`
      : paint(fill.repeat(size).padEnd(barWidth), 'accent', options)
    // Values never compete with a bar for the last terminal cells.
    if (width >= 76 && number.length <= 16)
      lines.push(`  ${pad(label, 24)}  ${mark}  ${pad(number, 16, true)}`)
    else
      lines.push(...textLines(`${label}  ${number}`, options), `  ${mark}`)
  }
  return lines
}

export function renderShare(rows: readonly BarRow[], metric: string, options: OutputOptions): string[] {
  if (rows.some(row => finite(row.value) === null || row.value! < 0))
    return textLines('Share unavailable: incomplete values.', options, 'warning')
  const total = rows.reduce((sum, row) => sum + row.value!, 0)
  if (total === 0)
    return textLines(`No ${metric} in returned rows.`, options)
  if (!Number.isFinite(total))
    return textLines('Share unavailable: total exceeds display range.', options, 'warning')
  const width = Math.min(40, contentWidth(options))
  const glyphs = options.unicode ? ['█', '░', '▒', '▓'] : ['#', '.', ':', '+']
  let cumulative = 0
  let used = 0
  const marks = rows.map((row, i) => {
    cumulative += row.value!
    const endpoint = Math.round(cumulative / total * width)
    const mark = glyphs[i % glyphs.length].repeat(endpoint - used)
    used = endpoint
    return paint(mark, i === 0 ? 'accent' : 'muted', options)
  }).join('')
  return [
    `  ${marks}`,
    '',
    ...rows.flatMap((row, i) => textLines(`${glyphs[i % glyphs.length]} ${row.label}  ${formatMetric('share', row.value! / total)}  ${formatMetric(metric, row.value)}`, options)),
    '',
    ...textLines(`${formatMetric(metric, total)} ${metric} in returned rows`, options, 'muted'),
  ]
}

export interface MetricValue {
  key: string
  label: string
  current: number | null
  previous?: number | null
}

export function renderMetrics(values: readonly MetricValue[], options: OutputOptions): string[] {
  return values.flatMap((value) => {
    const display = `${value.label}: ${formatMetric(value.key, value.current)}`
    if (value.previous === undefined)
      return textLines(display, options)
    const change = formatChange(value.key, value.current ?? Number.NaN, value.previous)
    return textLines(`${display}  ${change.text}`, options, change.direction)
  })
}

export type BucketUnit = 'day' | 'week' | 'month'
export interface SeriesRow {
  [key: string]: unknown
  label: string
  total: number | null
  points: readonly { date: string, value: number | null }[]
}

function bucketDate(value: string, unit: BucketUnit): Date | null {
  const input = unit === 'month' ? `${value.slice(0, 7)}-01` : value
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input))
    return null
  const date = new Date(`${input}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input)
    return null
  if (unit === 'week')
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  return date
}

export function calendarBuckets(start: string, end: string, unit: BucketUnit): string[] {
  const first = bucketDate(start, unit)
  const last = bucketDate(end, unit)
  if (!first || !last || first > last)
    return []
  const buckets: string[] = []
  const cursor = new Date(first)
  while (cursor.getTime() <= last.getTime()) {
    // Bound display work even if a programmatic caller supplies a huge period.
    if (buckets.length === 10000)
      return []
    buckets.push(cursor.toISOString().slice(0, unit === 'month' ? 7 : 10))
    if (unit === 'month')
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    else
      cursor.setUTCDate(cursor.getUTCDate() + (unit === 'week' ? 7 : 1))
  }
  return buckets
}

export function renderSparklines(rows: readonly SeriesRow[], range: { start: string, end: string, unit: BucketUnit }, metric: string, options: OutputOptions, extraColumns: readonly TableColumn[] = []): string[] {
  const buckets = calendarBuckets(range.start, range.end, range.unit)
  if (!buckets.length)
    return textLines('Series unavailable for this date range.', options, 'warning')
  const width = contentWidth(options)
  const chartWidth = Math.max(1, width >= 64 ? Math.min(extraColumns.length ? 12 : 28, width - 40) : width)
  const group = Math.ceil(buckets.length / chartWidth)
  const gap = options.unicode ? '·' : '?'
  const glyphs = options.unicode ? '▁▂▃▄▅▆▇█' : '12345678'
  const plotted: Record<string, unknown>[] = []
  let missing = false
  for (const row of rows) {
    const map = new Map(row.points.map(point => [point.date, finite(point.value)]))
    const values: Array<number | null> = []
    for (let i = 0; i < buckets.length; i += group) {
      const cell = buckets.slice(i, i + group).map(date => map.get(date) ?? null)
      values.push(cell.includes(null) ? null : cell.reduce<number>((sum, value) => sum + value!, 0))
    }
    const known = values.filter((value): value is number => value !== null && Number.isFinite(value))
    const min = known.reduce((n, value) => Math.min(n, value), Infinity)
    const max = known.reduce((n, value) => Math.max(n, value), -Infinity)
    const spark = values.map(value => value === null || !Number.isFinite(value)
      ? gap
      : glyphs[max === min ? (max === 0 ? 0 : 3) : Math.round((value - min) / (max - min) * 7)]).join('')
    missing ||= spark.includes(gap)
    plotted.push({ ...row, spark })
  }
  const lines = renderTable(plotted, [
    { key: 'label', label: '' },
    { key: 'total', label: metricLabel(metric), numeric: true, format: value => formatMetric(metric, value) },
    { key: 'spark', label: { day: 'Daily', week: 'Weekly', month: 'Monthly' }[range.unit], numeric: true, tone: 'accent' },
    ...extraColumns,
  ], options)
  const notes: string[] = []
  if (rows.length > 1)
    notes.push('row scales')
  if (missing)
    notes.push(`${gap} missing`)
  if (group > 1)
    notes.push(`sum / ${group} ${range.unit}s`)
  if (!options.unicode)
    notes.push('1 low, 8 high')
  if (notes.length)
    lines.push(...textLines(notes.join(' | '), options, 'muted'))
  return lines
}
