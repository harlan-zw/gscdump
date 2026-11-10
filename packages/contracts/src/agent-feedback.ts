import { z } from 'zod'

const singleLine = (max: number): z.ZodString => z.string().trim().min(1).max(max).regex(/^\P{Cc}*$/u, 'must be a single line without control characters')
const safeMetadata = (max: number): z.ZodString => singleLine(max).refine(value => redactAgentFeedbackText(value) === value, 'Use metadata without credentials, URLs, or email addresses.')
const correlationId = safeMetadata(128).regex(/^[\w.:-]+$/)

/** Declared context helps reproduce reports. It never grants access or proves credential origin. */
export const agentFeedbackContextSchema = z.strictObject({
  requestId: correlationId.optional(),
  parentRequestId: correlationId.optional(),
  workflowId: correlationId.optional(),
  origin: singleLine(253).regex(/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i).optional(),
  product: safeMetadata(64).regex(/^[a-z\d][\w.-]*$/i).optional(),
  surface: z.enum(['cli', 'mcp', 'api', 'skill', 'browser']).optional(),
  operation: safeMetadata(200).optional(),
  skillDigest: z.string().regex(/^[a-f\d]{64}$/).optional(),
  skillVersion: safeMetadata(64).optional(),
})

export type AgentFeedbackContext = z.infer<typeof agentFeedbackContextSchema>

export const agentRequestContextSchema = agentFeedbackContextSchema.pick({ parentRequestId: true, workflowId: true, product: true, skillDigest: true }).extend({ cliVersion: safeMetadata(64).optional(), client: safeMetadata(100).optional() })
export type AgentRequestContext = z.infer<typeof agentRequestContextSchema>
export const AGENT_REQUEST_HEADERS = {
  parentRequestId: 'x-parent-request-id',
  workflowId: 'x-workflow-id',
  product: 'x-gscdump-product',
  cliVersion: 'x-gscdump-cli-version',
  skillDigest: 'x-gscdump-skill-digest',
  client: 'x-gscdump-client',
} as const satisfies Record<keyof AgentRequestContext, string>

/** Defense in depth for free text. Callers must still remove private content. */
export function redactAgentFeedbackText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(/\b(?:set-cookie|cookie)\s*:[^\r\n]+/gi, 'Cookie: [redacted]')
    .replace(/\b((?:[a-z\d]+[_-])*(?:access_token|refresh_token|token|api_key|secret|password))\s*[:=]\s*["']?[^\s,;"']+/gi, '$1=[redacted]')
    .replace(/\b(?:gsd_(?:user|team|partner|prod|dev)_|sk-|ya29\.)[\w.-]+/gi, '[redacted]')
    .replace(/\b[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z]{2,}\b/gi, '[redacted email]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[redacted URL]')
}

export const cliPapercutBodySchema = z.strictObject({
  ...agentFeedbackContextSchema.shape,
  command: singleLine(200).transform(redactAgentFeedbackText),
  comment: z.string().trim().min(1).max(2000).transform(redactAgentFeedbackText),
  agent: singleLine(100).transform(redactAgentFeedbackText),
  intent: z.enum(['bug', 'improvement']).default('bug'),
  cliVersion: safeMetadata(64),
  node: safeMetadata(64),
  platform: safeMetadata(32),
})

export type CliPapercutBody = z.infer<typeof cliPapercutBodySchema>

/** Explicit agent reports describe quality. They never establish a verified repair. */
export const agentOutcomeBodySchema = z.strictObject({
  ...agentFeedbackContextSchema.shape,
  eventId: correlationId,
  workflowId: correlationId,
  product: safeMetadata(64).regex(/^[a-z\d][\w.-]*$/i).default('gscdump'),
  surface: z.enum(['cli', 'mcp', 'api', 'skill', 'browser']),
  operation: safeMetadata(200).regex(/^[\w.:-]+$/),
  step: z.enum(['setup', 'read', 'diagnose', 'fix', 'verify', 'complete']),
  outcome: z.enum(['success', 'failure', 'blocked', 'cancelled']),
  semanticFlags: z.array(z.enum(['empty', 'unavailable', 'refused', 'provisional', 'partial', 'stale', 'truncated'])).max(7).default([]),
  rowCount: z.number().int().min(0).max(1_000_000).optional(),
  durationMs: z.number().int().min(0).max(600_000).optional(),
  quality: z.enum(['useful', 'unusable', 'incorrect', 'unknown']).default('unknown'),
  errorCode: safeMetadata(200).regex(/^[\w.:-]+$/).optional(),
  cliVersion: safeMetadata(64).optional(),
}).omit({ origin: true })

export type AgentOutcomeBody = z.infer<typeof agentOutcomeBodySchema>
export const agentOutcomeReceiptSchema = z.strictObject({ id: singleLine(128), evidenceClass: z.literal('declared'), duplicate: z.boolean() })
export type AgentOutcomeReceipt = z.infer<typeof agentOutcomeReceiptSchema>
