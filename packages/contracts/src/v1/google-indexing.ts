// Manual Google Indexing API delivery through the hosted protocol.
// gscdump.com ADR-0016 records the decision. The consumer selects each URL;
// gscdump stores the grant, applies the guards, and keeps the receipts.
import { z } from 'zod'
import { defineResponseObject } from './http-core'

/** Notifications one Site may send in one Pacific day. */
export const GOOGLE_SUBMISSION_SITE_DAILY_LIMIT = 5
/** Days after an accepted notification before the same URL may be sent again. */
export const GOOGLE_SUBMISSION_URL_COOLDOWN_DAYS = 7
/** Google's default publish quota for one Cloud project in one Pacific day. */
export const GOOGLE_INDEXING_API_PROJECT_DAILY_DEFAULT = 200
/** Attempts one idempotency key may make before its receipt stays `failed`. */
export const GOOGLE_SUBMISSION_MAX_ATTEMPTS = 3

const count = z.number().int().nonnegative()
const pageUrl = z.url({ protocol: /^https?$/ })

/**
 * `partner.users.indexing.google.grant.update`. The partner runs Google's
 * consent with its dedicated Indexing API client, then hands over the refresh
 * token and the scopes Google granted. gscdump refuses a grant whose `scope`
 * lacks `https://www.googleapis.com/auth/indexing`.
 */
export const indexingApiGrantUpdateV1Schema = z.strictObject({
  refreshToken: z.string().min(1),
  scope: z.string().min(1),
  googleEmail: z.email().nullable(),
})

/**
 * The Indexing API grant of one user for the calling partner.
 *
 * - `missing`: the partner has handed over no grant, or it was revoked.
 * - `granted`: gscdump can send notifications with it.
 * - `reauthorization-required`: Google refused the stored grant. The partner
 *   hands over a new one before any Submission.
 */
const missingGrant = defineResponseObject({ _tag: z.literal('missing') })
const grantedGrant = defineResponseObject({
  _tag: z.literal('granted'),
  googleEmail: z.string().nullable(),
  grantedAt: z.iso.datetime(),
})
const reauthorizationGrant = defineResponseObject({
  _tag: z.literal('reauthorization-required'),
  googleEmail: z.string().nullable(),
})

export const indexingApiGrantV1Schemas = {
  producer: z.discriminatedUnion('_tag', [missingGrant.producer, grantedGrant.producer, reauthorizationGrant.producer]),
  client: z.discriminatedUnion('_tag', [missingGrant.client, grantedGrant.client, reauthorizationGrant.client]),
}
export const indexingApiGrantV1Schema = indexingApiGrantV1Schemas.producer
export type IndexingApiGrantV1 = z.infer<typeof indexingApiGrantV1Schema>

/**
 * `partner.sites.indexing.google.grant.get`. The Indexing API grant a Google
 * Submission for this Site uses: the Site user's grant for the calling
 * partner. It names no Google account, because the caller may act for a Team
 * member who is not that user.
 *
 * - `unavailable`: the partner has no usable Indexing API client, so every
 *   Submission is refused as `indexing_api_unavailable`.
 * - `missing`, `granted`, `reauthorization-required`: as for the user's grant.
 */
const unavailableSiteGrant = defineResponseObject({ _tag: z.literal('unavailable') })
const grantedSiteGrant = defineResponseObject({ _tag: z.literal('granted'), grantedAt: z.iso.datetime() })
const reauthorizationSiteGrant = defineResponseObject({ _tag: z.literal('reauthorization-required') })

export const siteIndexingApiGrantV1Schemas = {
  producer: z.discriminatedUnion('_tag', [unavailableSiteGrant.producer, missingGrant.producer, grantedSiteGrant.producer, reauthorizationSiteGrant.producer]),
  client: z.discriminatedUnion('_tag', [unavailableSiteGrant.client, missingGrant.client, grantedSiteGrant.client, reauthorizationSiteGrant.client]),
}
export const siteIndexingApiGrantV1Schema = siteIndexingApiGrantV1Schemas.producer
export type SiteIndexingApiGrantV1 = z.infer<typeof siteIndexingApiGrantV1Schema>

/** `partner.sites.indexing.google.submissions.create`. One URL per request. */
export const googleSubmitV1Schema = z.strictObject({
  url: pageUrl,
  idempotencyKey: z.string().min(1).max(128),
})

/**
 * Why Google refused a notification. gscdump never retries a rejection.
 *
 * - `not-owner`: the grant's Google account does not own the property.
 * - `access-revoked`: Google disabled the Indexing API for the partner's
 *   Cloud project. gscdump pauses the partner's Google delivery.
 * - `quota-exhausted`: Google's project quota is spent until the next Pacific day.
 * - `reauthorization-required`: Google refused the stored grant.
 */
export const GOOGLE_SUBMISSION_REJECTION_REASONS = [
  'not-owner',
  'access-revoked',
  'quota-exhausted',
  'reauthorization-required',
] as const

export type GoogleSubmissionRejectionReason = typeof GOOGLE_SUBMISSION_REJECTION_REASONS[number]

const receiptShape = {
  id: z.string().min(1),
  url: pageUrl,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  attempts: z.number().int().min(1).max(GOOGLE_SUBMISSION_MAX_ATTEMPTS),
}

/**
 * The Submission Receipt of one Google Indexing API notification.
 *
 * - `accepted`: Google answered 200. This proves receipt, never indexing.
 * - `rejected`: Google refused the notification for `reason`. `httpStatus` is
 *   null when Google refused the grant before the notification was sent.
 * - `failed`: Google answered 5xx, or the request failed. A repeat with the
 *   same idempotency key retries, up to `GOOGLE_SUBMISSION_MAX_ATTEMPTS` attempts.
 */
const acceptedReceipt = defineResponseObject({
  _tag: z.literal('accepted'),
  ...receiptShape,
  httpStatus: z.literal(200),
  reason: z.null(),
})
const rejectedReceipt = defineResponseObject({
  _tag: z.literal('rejected'),
  ...receiptShape,
  httpStatus: z.number().int().min(400).max(499).nullable(),
  reason: z.enum(GOOGLE_SUBMISSION_REJECTION_REASONS),
})
const failedReceipt = defineResponseObject({
  _tag: z.literal('failed'),
  ...receiptShape,
  httpStatus: z.number().int().min(100).max(599).nullable(),
  reason: z.string().min(1),
})

export const googleSubmissionReceiptV1Schemas = {
  producer: z.discriminatedUnion('_tag', [acceptedReceipt.producer, rejectedReceipt.producer, failedReceipt.producer]),
  client: z.discriminatedUnion('_tag', [acceptedReceipt.client, rejectedReceipt.client, failedReceipt.client]),
}
export const googleSubmissionReceiptV1Schema = googleSubmissionReceiptV1Schemas.producer
export type GoogleSubmissionReceiptV1 = z.infer<typeof googleSubmissionReceiptV1Schema>

/**
 * The `details.reason` values of a v1 error envelope that refuses a Google
 * Submission before gscdump sends anything. They are snake_case, like the
 * entitlement refusals.
 */
export const GOOGLE_SUBMISSION_REFUSAL_REASONS = [
  'indexing_api_unavailable',
  'needs_indexing_api_grant',
  'url_outside_site',
  'cooling_down',
  'site_daily_limit',
  'project_quota_spent',
] as const

export type GoogleSubmissionRefusalReason = typeof GOOGLE_SUBMISSION_REFUSAL_REASONS[number]

/**
 * The `details` of a v1 error envelope that refuses a Google Submission.
 *
 * - `indexing_api_unavailable` (409 `invalid_request`): the partner has no
 *   Indexing API client, or gscdump paused its Google delivery.
 * - `needs_indexing_api_grant` (409 `invalid_request`): the Site's user holds
 *   no usable Indexing API grant for this partner. `grant` says which.
 * - `url_outside_site` (400 `invalid_request`): the URL is not on the
 *   registered Site host, or not inside its URL-prefix property.
 * - `cooling_down` (409 `invalid_request`): Google accepted this URL at
 *   `lastAcceptedAt`. It may be sent again at `availableAt`.
 * - `site_daily_limit` (429 `rate_limited`): the Site sent `limit`
 *   notifications this Pacific day. The count resets at `resetsAt`.
 * - `project_quota_spent` (429 `rate_limited`): the partner's Cloud project
 *   has no quota left this Pacific day. It resets at `resetsAt`.
 *
 * Unknown `details` keys are dropped, so a newer host can add keys.
 */
export const googleSubmissionRefusalSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('indexing_api_unavailable') }),
  z.object({ reason: z.literal('needs_indexing_api_grant'), grant: z.enum(['missing', 'reauthorization-required']) }),
  z.object({ reason: z.literal('url_outside_site') }),
  z.object({ reason: z.literal('cooling_down'), lastAcceptedAt: z.iso.datetime(), availableAt: z.iso.datetime() }),
  z.object({ reason: z.literal('site_daily_limit'), limit: count, resetsAt: z.iso.datetime() }),
  z.object({ reason: z.literal('project_quota_spent'), resetsAt: z.iso.datetime() }),
])

export type GoogleSubmissionRefusal = z.infer<typeof googleSubmissionRefusalSchema>

/**
 * Read a Google Submission refusal from the `details` of a v1 error envelope,
 * such as `GscdumpV1Error.details`. Returns `null` when the details describe a
 * different failure, or a refusal this contract version does not know.
 */
export function parseGoogleSubmissionRefusal(details: unknown): GoogleSubmissionRefusal | null {
  const parsed = googleSubmissionRefusalSchema.safeParse(details)
  return parsed.success ? parsed.data : null
}
