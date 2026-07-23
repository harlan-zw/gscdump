import { addDays } from '../../core/gsc-dates'

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
  return addDays(currentPstDate(), -n)
}
