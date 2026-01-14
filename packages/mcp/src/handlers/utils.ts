import type { ResolvedPeriodRange } from 'gscdump'
import type { z } from 'zod'
import type { periodRangeInput } from '../types'
import { userPeriodRange } from 'gscdump'

export function parsePeriod(
  input: z.infer<typeof periodRangeInput>,
): ResolvedPeriodRange {
  return userPeriodRange(input.period || '30d')
}
