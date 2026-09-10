import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'

export interface OutputOptions {
  columns: number
  color: boolean
  unicode: boolean
}

export type Tone = 'accent' | 'muted' | 'good' | 'bad' | 'warning' | 'neutral'

/** Data labels cannot inject terminal commands or extra rows. */
export function cleanText(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/g, ' ')
}

export function contentWidth(options: OutputOptions): number {
  return Math.max(1, (Number.isFinite(options.columns) ? Math.floor(options.columns) : 80) - 2)
}

export function paint(text: string, tone: Tone, options: OutputOptions): string {
  const code = { accent: 36, muted: 90, good: 32, bad: 31, warning: 33, neutral: 0 }[tone]
  return options.color && tone !== 'neutral' ? `\x1B[${code}m${text}\x1B[0m` : text
}

export function fitLabel(value: unknown, width: number, options: OutputOptions): string {
  const text = cleanText(value)
  if (stringWidth(text) <= width)
    return text
  const marker = options.unicode ? '…' : '~'
  let result = ''
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
    if (stringWidth(result + segment + marker) > width)
      break
    result += segment
  }
  return width > 0 ? result + marker : ''
}

export function pad(value: string, width: number, right = false): string {
  const spaces = ' '.repeat(Math.max(0, width - stringWidth(value)))
  return right ? spaces + value : value + spaces
}

export function textLines(value: unknown, options: OutputOptions, tone: Tone = 'neutral'): string[] {
  const text = cleanText(value)
  const width = contentWidth(options)
  const lines: string[] = []
  let row = ''
  const flush = (): void => {
    if (row.trim())
      lines.push(`  ${paint(row.trimEnd(), tone, options)}`)
    row = ''
  }
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  for (const word of text.split(/(\s+)/)) {
    if (!word)
      continue
    if (stringWidth(word) <= width) {
      if (stringWidth(row + word) > width)
        flush()
      if (row || word.trim())
        row += word
      continue
    }
    flush()
    for (const { segment } of segmenter.segment(word)) {
      if (row && stringWidth(row + segment) > width)
        flush()
      row += segment
    }
  }
  lines.push(`  ${paint(row.trimEnd(), tone, options)}`)
  return lines
}

export interface TableColumn {
  key: string
  label: string
  numeric?: boolean
  format?: (value: unknown) => string
}

export function renderTable(rows: readonly Record<string, unknown>[], columns: readonly TableColumn[], options: OutputOptions): string[] {
  if (rows.length === 0)
    return textLines('No results for this period.', options)
  const labels = columns.map(col => cleanText(col.label))
  const cells = rows.map(row => columns.map(col => cleanText(col.format ? col.format(row[col.key]) : row[col.key] ?? 'n/a')))
  if (columns.length === 0)
    return []
  const widths = columns.map((_, i) => cells.reduce((width, row) => Math.max(width, stringWidth(row[i])), stringWidth(labels[i])))
  let totalWidth = widths.reduce((sum, width) => sum + width, 0) + (columns.length - 1) * 2
  if (contentWidth(options) >= 60) {
    for (const [i, column] of columns.entries()) {
      if (column.numeric || totalWidth <= contentWidth(options))
        continue
      const reduction = Math.min(widths[i] - Math.max(8, stringWidth(labels[i])), totalWidth - contentWidth(options))
      if (reduction > 0) {
        widths[i] -= reduction
        totalWidth -= reduction
      }
    }
  }
  if (totalWidth > contentWidth(options)) {
    return cells.flatMap(row => [
      ...columns.flatMap((_, i) => textLines(`${labels[i]}: ${row[i]}`, options)),
      '',
    ])
  }
  const line = (values: string[], truncate = false): string => `  ${values.map((value, i) => pad(truncate && !columns[i].numeric ? fitLabel(value, widths[i], options) : value, widths[i], columns[i].numeric)).join('  ')}`
  return [
    line(labels),
    `  ${paint(widths.map(width => (options.unicode ? '─' : '-').repeat(width)).join('  '), 'muted', options)}`,
    ...cells.map(row => line(row, true)),
  ]
}
