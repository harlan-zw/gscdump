import { consola } from 'consola'

export const logger = consola.withTag('gscdump-cloud')

export const VERSION = '1.0.0'

export const DEFAULT_CLOUD_URL = 'https://gscdump.com'

export function progressBar(current: number, total: number, label: string, width = 30): string {
  const percent = Math.min(current / total, 1)
  const filled = Math.round(width * percent)
  const empty = width - filled
  const bar = `\x1B[36m${'█'.repeat(filled)}\x1B[0m\x1B[90m${'░'.repeat(empty)}\x1B[0m`
  return `  ${bar} \x1B[90m${current}/${total}\x1B[0m ${label}`
}
