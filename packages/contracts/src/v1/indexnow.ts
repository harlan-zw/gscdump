import { z } from 'zod'

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.search
})
export const indexNowKeyV1Schema = z.string().min(8).max(128).regex(/^[a-z0-9-]+$/i)
export const indexNowConfigureV1Schema = z.strictObject({ key: indexNowKeyV1Schema, keyLocation: httpsUrl.optional() })
export const indexNowSubmitV1Schema = z.strictObject({ urls: z.array(z.url()).min(1).max(1000), idempotencyKey: z.string().min(1).max(128) })

/**
 * Automatic sending: gscdump sends a Site's new and changed sitemap URLs to
 * IndexNow after each sitemap update. It is off until the owner turns it on.
 */
export const INDEXNOW_AUTOMATIC_SENDING_STATES = ['on', 'off'] as const
export const indexNowAutomaticSendingUpdateV1Schema = z.strictObject({ automaticSending: z.enum(INDEXNOW_AUTOMATIC_SENDING_STATES) })

/** Why one automatic check left changed URLs unsent. */
export const INDEXNOW_AUTOMATIC_TRUNCATION_REASONS = ['daily-limit', 'scan-limit'] as const
const automaticCheckCompleteness = z.discriminatedUnion('_tag', [
  z.strictObject({ _tag: z.literal('complete') }),
  z.strictObject({ _tag: z.literal('truncated'), reasons: z.array(z.enum(INDEXNOW_AUTOMATIC_TRUNCATION_REASONS)).min(1) }),
])
const automaticCheckShape = {
  checkedAt: z.iso.datetime(),
  // New or changed sitemap URLs inside the key scope, found since the previous check.
  changedUrls: z.number().int().min(0),
  // URLs the check put into an automatic Submission.
  sentUrls: z.number().int().min(0),
  completeness: automaticCheckCompleteness,
}
const automaticSendingOffShape = { _tag: z.literal('off') }
const automaticSendingOnShape = { _tag: z.literal('on'), since: z.iso.datetime(), lastCheck: z.strictObject(automaticCheckShape).nullable() }
export const indexNowAutomaticSendingV1Schema = z.discriminatedUnion('_tag', [
  z.strictObject(automaticSendingOffShape),
  z.strictObject(automaticSendingOnShape),
])
const automaticSendingClientSchema = z.discriminatedUnion('_tag', [
  z.looseObject(automaticSendingOffShape),
  z.looseObject({ ...automaticSendingOnShape, lastCheck: z.looseObject(automaticCheckShape).nullable() }),
])
export const indexNowAutomaticSendingV1Schemas = {
  producer: indexNowAutomaticSendingV1Schema,
  // A host that predates automatic sending sends no field. It never sent automatically.
  client: automaticSendingClientSchema.default({ _tag: 'off' }),
}

const connectionShape = { host: z.string().min(1), keyLocation: httpsUrl }
export const indexNowConnectionV1Schema = z.discriminatedUnion('_tag', [
  z.strictObject({ _tag: z.literal('disconnected'), host: z.string().min(1) }),
  z.strictObject({ _tag: z.literal('verification-required'), ...connectionShape, reason: z.string().nullable(), automaticSending: indexNowAutomaticSendingV1Schema }),
  z.strictObject({ _tag: z.literal('connected'), ...connectionShape, verifiedAt: z.iso.datetime(), automaticSending: indexNowAutomaticSendingV1Schema }),
])
export const indexNowConnectionV1Schemas = {
  producer: indexNowConnectionV1Schema,
  client: z.discriminatedUnion('_tag', [
    z.looseObject({ _tag: z.literal('disconnected'), host: z.string().min(1) }),
    z.looseObject({ _tag: z.literal('verification-required'), ...connectionShape, reason: z.string().nullable(), automaticSending: indexNowAutomaticSendingV1Schemas.client }),
    z.looseObject({ _tag: z.literal('connected'), ...connectionShape, verifiedAt: z.iso.datetime(), automaticSending: indexNowAutomaticSendingV1Schemas.client }),
  ]),
}

/**
 * Who chose the URLs of a Submission. `manual` URLs come from the caller.
 * `automatic` URLs come from the Site's sitemap changes.
 */
export const INDEXNOW_SUBMISSION_TRIGGERS = ['manual', 'automatic'] as const
export const indexNowSubmissionTriggerV1Schema = z.enum(INDEXNOW_SUBMISSION_TRIGGERS)

const receiptShape = {
  id: z.string().min(1),
  trigger: indexNowSubmissionTriggerV1Schema,
  urls: z.array(z.url()).min(1).max(1000),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  attempts: z.number().int().min(0),
}
const queuedShape = { _tag: z.literal('queued'), ...receiptShape, httpStatus: z.null(), reason: z.null(), retryAt: z.null() }
const acceptedShape = { _tag: z.literal('accepted'), ...receiptShape, httpStatus: z.literal(200), reason: z.null(), retryAt: z.null() }
const pendingShape = { _tag: z.literal('pending'), ...receiptShape, httpStatus: z.literal(202), reason: z.literal('key-validation-pending'), retryAt: z.null() }
const rejectedShape = { _tag: z.literal('rejected'), ...receiptShape, httpStatus: z.union([z.literal(400), z.literal(403), z.literal(422)]), reason: z.string().min(1), retryAt: z.null() }
const retryingShape = { _tag: z.literal('retrying'), ...receiptShape, httpStatus: z.number().int().min(100).max(599).nullable(), reason: z.string().min(1), retryAt: z.iso.datetime() }
const failedShape = { _tag: z.literal('failed'), ...receiptShape, httpStatus: z.number().int().min(100).max(599).nullable(), reason: z.string().min(1), retryAt: z.null() }
// A host that predates automatic sending sends no trigger. Every Submission it holds is manual.
const clientTrigger = { trigger: indexNowSubmissionTriggerV1Schema.default('manual') }
export const indexNowSubmissionReceiptV1Schema = z.discriminatedUnion('_tag', [
  z.strictObject(queuedShape),
  z.strictObject(acceptedShape),
  z.strictObject(pendingShape),
  z.strictObject(rejectedShape),
  z.strictObject(retryingShape),
  z.strictObject(failedShape),
])
export const indexNowSubmissionReceiptV1Schemas = {
  producer: indexNowSubmissionReceiptV1Schema,
  client: z.discriminatedUnion('_tag', [
    z.looseObject({ ...queuedShape, ...clientTrigger }),
    z.looseObject({ ...acceptedShape, ...clientTrigger }),
    z.looseObject({ ...pendingShape, ...clientTrigger }),
    z.looseObject({ ...rejectedShape, ...clientTrigger }),
    z.looseObject({ ...retryingShape, ...clientTrigger }),
    z.looseObject({ ...failedShape, ...clientTrigger }),
  ]),
}
export type IndexNowAutomaticSendingV1 = z.infer<typeof indexNowAutomaticSendingV1Schema>
export type IndexNowConnectionV1 = z.infer<typeof indexNowConnectionV1Schema>
export type IndexNowSubmissionTriggerV1 = z.infer<typeof indexNowSubmissionTriggerV1Schema>
export type IndexNowSubmissionReceiptV1 = z.infer<typeof indexNowSubmissionReceiptV1Schema>
