// Subpath imports: the `date-fns` barrel loads ~300 modules (~500ms cold),
// which every consumer pays at import time (vitest workers, CLI startup).
import { format } from 'date-fns/format'
import { subDays } from 'date-fns/subDays'

let pstFormatter: Intl.DateTimeFormat | undefined

function getPstFormatter(): Intl.DateTimeFormat {
  pstFormatter ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return pstFormatter
}

function pstDateParts(d: Date = new Date()): { year: number, month: number, day: number } {
  const parts = getPstFormatter().formatToParts(d)
  const get = (t: string): number => Number(parts.find(p => p.type === t)!.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

export function currentPstDate(): string {
  const { year, month, day } = pstDateParts()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function daysAgoPst(n: number): string {
  const { year, month, day } = pstDateParts()
  return format(subDays(new Date(year, month - 1, day, 12), n), 'yyyy-MM-dd')
}
