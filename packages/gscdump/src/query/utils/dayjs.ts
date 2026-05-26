import { format, subDays } from 'date-fns'

const PST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function pstDateParts(d: Date = new Date()): { year: number, month: number, day: number } {
  const parts = PST_FORMATTER.formatToParts(d)
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
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
