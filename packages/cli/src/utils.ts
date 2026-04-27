import process from 'node:process'
import { consola } from 'consola'
import { formatErrorForCli } from 'gscdump'

export const VERSION = '1.0.0'

export const logger = consola.withTag('gscdump')

/**
 * .catch() handler for GSC API errors — prints a formatted message and exits 1.
 * Use: somePromise.catch(gscErrorHandler)
 */
export function gscErrorHandler(error: unknown): never {
  console.error()
  console.error(formatErrorForCli(error))
  console.error()
  process.exit(1)
}

// Gradient colors for splash (green -> cyan -> blue)
const gradientColors = [
  (s: string) => `\x1B[38;2;52;211;153m${s}\x1B[0m`, // emerald
  (s: string) => `\x1B[38;2;45;212;191m${s}\x1B[0m`, // teal
  (s: string) => `\x1B[38;2;34;211;238m${s}\x1B[0m`, // cyan
  (s: string) => `\x1B[38;2;56;189;248m${s}\x1B[0m`, // sky
  (s: string) => `\x1B[38;2;96;165;250m${s}\x1B[0m`, // blue
]

function applyGradient(text: string): string {
  return [...text].map((char, i) => {
    const colorIndex = Math.floor((i / text.length) * gradientColors.length)
    return gradientColors[Math.min(colorIndex, gradientColors.length - 1)](char)
  }).join('')
}

export function showSplash(): void {
  console.log()
  console.log(`  ${applyGradient('GSC Dump')} v${VERSION}`)
  console.log()
}

export function clearLine(): void {
  process.stdout.write('\r\x1B[K')
}

/**
 * Human-readable "X ago" for a millisecond timestamp.
 * Returns "just now", "Nm ago", "Nh ago", or "Nd ago".
 */
export function formatAge(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 60_000)
    return 'just now'
  if (delta < 3_600_000)
    return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000)
    return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

/**
 * Run an async processor across a list with bounded concurrency.
 * Workers share a cursor so each item is processed exactly once; processor
 * exceptions propagate.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  processor: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const cursor = { i: 0 }
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor.i++
      if (i >= items.length)
        return
      await processor(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

const PERIOD_RE = /^(\d+)([dmy])$/i

export function parsePeriod(periodStr: string): { amount: number, unit: 'days' | 'months' | 'years' } | null {
  const match = periodStr.match(PERIOD_RE)
  if (!match)
    return null

  const amount = Number.parseInt(match[1], 10)
  const unitMap: Record<string, 'days' | 'months' | 'years'> = { d: 'days', m: 'months', y: 'years' }
  const unit = unitMap[match[2].toLowerCase()]

  if (!unit || amount <= 0)
    return null
  if (amount > 450 && unit === 'days')
    return null

  return { amount, unit }
}

// CSV conversion
export function toCSV(data: any[], columns: string[]): string {
  const header = columns.join(',')
  const rows = data.map(row =>
    columns.map((col) => {
      const val = row[col]
      if (val === null || val === undefined)
        return ''
      const str = String(val)
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str
    }).join(','),
  )
  return [header, ...rows].join('\n')
}

export function exportToCSV(output: any): string {
  const sections: string[] = []

  if (output.pages?.data) {
    const cols = ['url', 'clicks', 'impressions', 'ctr', 'position']
    sections.push(`# Pages\n${toCSV(output.pages.data, cols)}`)
  }

  if (output.keywords?.current) {
    const cols = ['query', 'clicks', 'impressions', 'ctr', 'position']
    sections.push(`# Keywords (Current Period)\n${toCSV(output.keywords.current, cols)}`)
  }

  if (output.countries?.current) {
    const cols = ['country', 'clicks', 'impressions', 'ctr', 'position']
    sections.push(`# Countries (Current Period)\n${toCSV(output.countries.current, cols)}`)
  }

  if (output.devices?.current) {
    const cols = ['device', 'clicks', 'impressions', 'ctr', 'position']
    sections.push(`# Devices (Current Period)\n${toCSV(output.devices.current, cols)}`)
  }

  return sections.join('\n\n')
}
