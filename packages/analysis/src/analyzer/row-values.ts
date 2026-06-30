import type { Row } from '@gscdump/engine/contracts'

export function rowNumber(value: unknown): number {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint')
    return Number(value)
  if (value == null)
    return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function rowString(value: unknown): string {
  return value == null ? '' : String(value)
}

export function rowBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === 'true'
}

export function parseJsonRows<T extends Record<string, unknown> = Row>(value: unknown): T[] {
  if (Array.isArray(value))
    return value as T[]
  if (typeof value === 'string' && value.length > 0) {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  }
  return []
}
