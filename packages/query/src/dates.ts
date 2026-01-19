import { currentPstDate, dayjsPst } from 'gscdump'

export function today(): string {
  return currentPstDate()
}

export function daysAgo(n: number): string {
  return dayjsPst().subtract(n, 'day').format('YYYY-MM-DD')
}
