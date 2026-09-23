import { addDays, getPstDate } from '../../core/gsc-dates'

export function currentPstDate(): string {
  return getPstDate()
}

export function daysAgoPst(n: number): string {
  return addDays(currentPstDate(), -n)
}
