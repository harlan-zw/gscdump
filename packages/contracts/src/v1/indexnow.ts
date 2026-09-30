import { z } from 'zod'

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.search
})
export const indexNowKeyV1Schema = z.string().min(8).max(128).regex(/^[a-z0-9-]+$/i)
export const indexNowConfigureV1Schema = z.strictObject({ key: indexNowKeyV1Schema, keyLocation: httpsUrl.optional() })
export const indexNowSubmitV1Schema = z.strictObject({ urls: z.array(z.url()).min(1).max(1000), idempotencyKey: z.string().min(1).max(128) })

const connectionShape = { host: z.string().min(1), keyLocation: httpsUrl }
export const indexNowConnectionV1Schema = z.discriminatedUnion('_tag', [
  z.strictObject({ _tag: z.literal('disconnected'), host: z.string().min(1) }),
  z.strictObject({ _tag: z.literal('verification-required'), ...connectionShape, reason: z.string().nullable() }),
  z.strictObject({ _tag: z.literal('connected'), ...connectionShape, verifiedAt: z.iso.datetime() }),
])
export const indexNowConnectionV1Schemas = {
  producer: indexNowConnectionV1Schema,
  client: z.discriminatedUnion('_tag', [
    z.looseObject({ _tag: z.literal('disconnected'), host: z.string().min(1) }),
    z.looseObject({ _tag: z.literal('verification-required'), ...connectionShape, reason: z.string().nullable() }),
    z.looseObject({ _tag: z.literal('connected'), ...connectionShape, verifiedAt: z.iso.datetime() }),
  ]),
}

const receiptShape = {
  id: z.string().min(1),
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
    z.looseObject(queuedShape),
    z.looseObject(acceptedShape),
    z.looseObject(pendingShape),
    z.looseObject(rejectedShape),
    z.looseObject(retryingShape),
    z.looseObject(failedShape),
  ]),
}
export type IndexNowConnectionV1 = z.infer<typeof indexNowConnectionV1Schema>
export type IndexNowSubmissionReceiptV1 = z.infer<typeof indexNowSubmissionReceiptV1Schema>
