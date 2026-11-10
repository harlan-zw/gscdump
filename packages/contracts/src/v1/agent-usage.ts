import { z } from 'zod'
import { defineResponseObject } from './http-core'

const activity = defineResponseObject({
  surface: z.enum(['mcp', 'cli', 'api', 'unknown']),
  client: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  configuredUsers: z.number().int().nonnegative().nullable(),
  successfulUsers: z.number().int().nonnegative().nullable(),
  successfulCalls: z.number().int().nonnegative().nullable(),
  firstObservedAt: z.iso.datetime().nullable(),
  lastObservedAt: z.iso.datetime().nullable(),
  coverage: z.enum(['retained', 'unavailable']),
  note: z.string().max(500),
})

/** Only credential-bound partner observations belong in this rollup. Null counts remain unknown. */
export const userIntegrationActivityV1Schemas = defineResponseObject({
  measuredAt: z.iso.datetime(),
  activities: z.array(activity.producer).max(100),
}, {
  measuredAt: z.iso.datetime(),
  activities: z.array(activity.client).max(100),
})

export type UserIntegrationActivityV1 = z.infer<typeof userIntegrationActivityV1Schemas.client>
