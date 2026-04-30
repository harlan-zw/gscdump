// Re-exports of raw codes; honoured at write time by the stdout wrapper in
// utils.ts (which strips ANSI when colour is disabled).
export const BOLD = '\x1B[1m'
export const DIM = '\x1B[2m'
export const RED = '\x1B[31m'
export const GREEN = '\x1B[32m'
export const YELLOW = '\x1B[33m'
export const BLUE = '\x1B[34m'
export const MAGENTA = '\x1B[35m'
export const CYAN = '\x1B[36m'
export const GRAY = '\x1B[90m'
export const RESET = '\x1B[0m'

export function colored(code: string, text: string | number): string {
  return `${code}${text}${RESET}`
}

export function deltaColor(value: number): string {
  if (value > 0)
    return GREEN
  if (value < 0)
    return RED
  return GRAY
}

export function severityColor(severity: 'error' | 'warning' | 'info' | string): string {
  if (severity === 'error')
    return RED
  if (severity === 'warning')
    return YELLOW
  return GRAY
}
