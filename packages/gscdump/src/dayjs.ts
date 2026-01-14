import type { Dayjs } from 'dayjs'
import _dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone.js'
import utc from 'dayjs/plugin/utc.js'

_dayjs.extend(utc)
_dayjs.extend(timezone)

export function dayjs(date?: _dayjs.ConfigType): Dayjs {
  return _dayjs(date)
}

export function currentPstDate(): string {
  return dayjs().tz('America/Los_Angeles').hour(12).minute(0).second(0).format('YYYY-MM-DD')
}

export function dayjsPst(): Dayjs {
  return dayjs().tz('America/Los_Angeles').hour(12).minute(0).second(0)
}
