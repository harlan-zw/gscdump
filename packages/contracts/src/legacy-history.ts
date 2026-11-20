import { z } from 'zod'

export const legacyHistoryNoticeSchema = z.object({
  _tag: z.literal('LegacyHistory'),
  historicalHostScope: z.literal('unverified'),
  dates: z.array(z.iso.date()).min(1),
})

export type LegacyHistoryNotice = z.infer<typeof legacyHistoryNoticeSchema>
