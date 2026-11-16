import { z } from 'zod'
import { defineResponseObject } from './http-core'

const count = z.number().int().nonnegative().nullable()
const instant = z.iso.datetime().nullable()
const agentJourney = z.strictObject({
  signedUpAt: z.iso.datetime(),
  configuredAt: instant,
  firstSuccessfulAt: instant,
  lastSuccessfulAt: instant,
  returnedAt: instant,
  successfulCalls: count,
  observedSince: instant,
  coverage: z.enum(['retained', 'unavailable']),
  returnAfterSeconds: z.literal(86400),
  returnBasis: z.literal('last_observed_success'),
})
const skill = z.strictObject({
  surface: z.enum(['mcp', 'cli', 'api']),
  client: z.string().min(1).max(100),
  name: z.string().min(1).max(80),
  version: z.string().max(40).nullable(),
  successfulUsers: count,
  successfulCalls: count,
  firstObservedAt: instant,
  lastObservedAt: instant,
  note: z.string().max(500),
})

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
  agentJourney: agentJourney.optional(),
  skills: z.array(skill).max(100).optional(),
  skillsTruncated: z.boolean().optional(),
}, {
  measuredAt: z.iso.datetime(),
  activities: z.array(activity.client).max(100),
  agentJourney: agentJourney.optional(),
  skills: z.array(skill).max(100).optional(),
  skillsTruncated: z.boolean().optional(),
})

export type UserIntegrationActivityV1 = z.infer<typeof userIntegrationActivityV1Schemas.client>
