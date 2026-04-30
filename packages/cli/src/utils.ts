import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { createConsola } from 'consola'
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version

// All progress/diagnostic logs go to stderr so stdout is reserved for
// machine-readable output (JSON, CSV, raw query results). Consola's default
// instance writes info/success/warn to stdout, which collides with `--json`
// pipes — this override fixes that without per-call branching.
const baseLogger = createConsola({
  stdout: process.stderr,
  stderr: process.stderr,
})

export const logger = baseLogger.withTag('gscdump')

/**
 * Silence info/success/warn so only errors surface. Use under `--quiet` /
 * `--json`; never call with `false` (we'd undo a `CONSOLA_LEVEL` env override).
 */
export function setQuiet(quiet: boolean): void {
  if (quiet)
    baseLogger.level = 1 // errors only (LogLevels.error = 0, .warn = 1; pause warns too if called explicitly)
}

// ANSI helpers honour NO_COLOR (https://no-color.org), `--no-color` argv,
// and non-TTY stdout. `setNoColor(true)` lets the top-level CLI override.
let colorEnabled: boolean = (() => {
  if (process.env.NO_COLOR)
    return false
  if (process.argv.includes('--no-color'))
    return false
  // Stderr-attached colour is fine even when stdout is piped — `logger` writes
  // to stderr, so check stderr's TTY status, not stdout's.
  return Boolean(process.stderr.isTTY) || Boolean(process.env.FORCE_COLOR)
})()

// Match a CSI escape sequence (ANSI colour code).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g

let stdoutWrapped = false
function wrapStdoutForNoColor(): void {
  if (stdoutWrapped)
    return
  stdoutWrapped = true
  // Strip ANSI from any stdout write so inline literals scattered across
  // commands automatically respect the no-colour setting without a sweep.
  // Stderr (the logger) is left alone — interactive users still get colour
  // even when piping stdout.
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: any, ...rest: any[]): boolean => {
    if (typeof chunk === 'string')
      chunk = chunk.replace(ANSI_RE, '')
    else if (chunk instanceof Uint8Array)
      chunk = Buffer.from(chunk).toString('utf8').replace(ANSI_RE, '')
    return original(chunk, ...rest)
  }) as typeof process.stdout.write
}

export function setNoColor(disable: boolean): void {
  if (disable) {
    colorEnabled = false
    wrapStdoutForNoColor()
  }
}

// Apply the initial state — if colour was disabled before any code ran (e.g.
// NO_COLOR env), wrap stdout immediately.
if (!colorEnabled)
  wrapStdoutForNoColor()

export function isColorEnabled(): boolean {
  return colorEnabled
}

const ANSI = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[90m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  cyan: '\x1B[36m',
} as const

export type Color = keyof typeof ANSI

export function color(c: Color, s: string | number): string {
  if (!colorEnabled)
    return String(s)
  return `${ANSI[c]}${s}${ANSI.reset}`
}

export function bold(s: string | number): string {
  return color('bold', s)
}
export function dim(s: string | number): string {
  return color('dim', s)
}
export function red(s: string | number): string {
  return color('red', s)
}
export function green(s: string | number): string {
  return color('green', s)
}
export function yellow(s: string | number): string {
  return color('yellow', s)
}
export function cyan(s: string | number): string {
  return color('cyan', s)
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
 * Format a path for display: relative to cwd when possible, with `~` for the
 * home directory otherwise. Avoids leaking the user's full home path into
 * logs and screenshots.
 */
export function displayPath(absPath: string): string {
  const cwd = process.cwd()
  const home = os.homedir()
  if (absPath === cwd)
    return '.'
  if (absPath.startsWith(`${cwd}/`))
    return absPath.slice(cwd.length + 1)
  if (absPath === home)
    return '~'
  if (absPath.startsWith(`${home}/`))
    return `~/${absPath.slice(home.length + 1)}`
  return absPath
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

/**
 * Read a list of URLs from positional args, --file, or stdin (one per line).
 * Comments (`# ...`) and blank lines are skipped.
 */
export async function readUrlList(args: { file?: unknown, urls?: unknown }): Promise<string[]> {
  if (args.file) {
    const content = await fs.readFile(String(args.file), 'utf-8')
    return content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  }
  if (args.urls) {
    const raw = Array.isArray(args.urls) ? args.urls : [args.urls]
    return raw.map(String).filter(Boolean)
  }
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  }
  return []
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
