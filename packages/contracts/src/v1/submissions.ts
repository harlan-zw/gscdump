import { z } from 'zod'
import { coverageStateTagSchema } from '../indexing-coverage'
import { indexNowSubmissionTriggerV1Schema } from './indexnow'

/**
 * Submissions across delivery channels: IndexNow and the Google Indexing API.
 * A Submission Receipt proves receipt only. An outcome shows what Google's
 * stored URL Inspection said afterwards: order in time, never cause.
 */
export const SUBMISSION_CHANNELS = ['indexnow', 'google'] as const
export const submissionChannelV1Schema = z.enum(SUBMISSION_CHANNELS)

/** The longest window, in days, a summary or outcome read covers. */
export const SUBMISSION_WINDOW_MAX_DAYS = 90
const windowDays = z.coerce.number().int().min(1).max(SUBMISSION_WINDOW_MAX_DAYS).default(30)

export const INDEXNOW_RECEIPT_STATES = ['queued', 'accepted', 'pending', 'rejected', 'retrying', 'failed'] as const
export const GOOGLE_RECEIPT_STATES = ['accepted', 'rejected', 'failed'] as const

const receiptListPage = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
}
const receiptListFilters = {
  // Receipts created at or after this instant.
  since: z.iso.datetime().optional(),
  // Receipts that carry this exact URL.
  url: z.url().optional(),
}

/** Query for `listSiteIndexNowSubmissionReceipts`. Every filter is optional and they combine with AND. */
export const indexNowReceiptListQueryV1Schema = z.strictObject({
  ...receiptListPage,
  ...receiptListFilters,
  state: z.enum(INDEXNOW_RECEIPT_STATES).optional(),
  trigger: indexNowSubmissionTriggerV1Schema.optional(),
})

/**
 * Query for `listSiteGoogleSubmissionReceipts`. Google Submissions are always
 * manual, so this list has no trigger filter.
 */
export const googleReceiptListQueryV1Schema = z.strictObject({
  ...receiptListPage,
  ...receiptListFilters,
  state: z.enum(GOOGLE_RECEIPT_STATES).optional(),
})

export const submissionSummaryQueryV1Schema = z.strictObject({ days: windowDays })

const count = z.number().int().min(0)
const windowShape = { days: z.number().int().min(1).max(SUBMISSION_WINDOW_MAX_DAYS), from: z.iso.datetime(), to: z.iso.datetime() }
const indexNowSummaryShape = {
  submissions: count,
  // URL sends: a URL in two Submissions counts twice.
  urls: count,
  urlsByState: z.strictObject(Object.fromEntries(INDEXNOW_RECEIPT_STATES.map(state => [state, count])) as Record<typeof INDEXNOW_RECEIPT_STATES[number], typeof count>),
  urlsByTrigger: z.strictObject({ manual: count, automatic: count }),
}
const googleSummaryShape = {
  // One Google Submission carries one URL. In-flight sends are not counted yet.
  submissions: count,
  byState: z.strictObject(Object.fromEntries(GOOGLE_RECEIPT_STATES.map(state => [state, count])) as Record<typeof GOOGLE_RECEIPT_STATES[number], typeof count>),
}

/** Counts of a Site's Submissions created inside the window. */
export const submissionSummaryV1Schema = z.strictObject({
  window: z.strictObject(windowShape),
  indexNow: z.strictObject(indexNowSummaryShape),
  google: z.strictObject(googleSummaryShape),
})
export const submissionSummaryV1Schemas = {
  producer: submissionSummaryV1Schema,
  client: z.looseObject({
    window: z.looseObject(windowShape),
    indexNow: z.looseObject({ ...indexNowSummaryShape, urlsByState: z.record(z.string(), count), urlsByTrigger: z.record(z.string(), count) }),
    google: z.looseObject({ ...googleSummaryShape, byState: z.record(z.string(), count) }),
  }),
}

export const SUBMISSION_OUTCOME_PAGE_MAX = 50
export const submissionOutcomesQueryV1Schema = z.strictObject({
  days: windowDays,
  channel: submissionChannelV1Schema.optional(),
  limit: z.coerce.number().int().min(1).max(SUBMISSION_OUTCOME_PAGE_MAX).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})

const inspectionShape = {
  // When gscdump stored this URL Inspection. The evidence clock.
  inspectedAt: z.iso.datetime(),
  verdict: z.string().nullable(),
  coverageState: coverageStateTagSchema,
  // Google's own last crawl, which can be earlier than the Submission even when the inspection is later.
  lastCrawledAt: z.iso.datetime().nullable(),
}

/**
 * Google's stored URL Inspection for one submitted URL, against the Submission time.
 *
 * - `inspected-after`: the latest stored inspection is newer than the Submission.
 * - `not-inspected-since`: the latest stored inspection predates the Submission.
 * - `never-inspected`: gscdump holds no inspection for the URL.
 * - `unavailable`: the inspection record could not be read for this response.
 */
const inspectedAfter = { _tag: z.literal('inspected-after'), ...inspectionShape }
const notInspectedSince = { _tag: z.literal('not-inspected-since'), ...inspectionShape }
const neverInspected = { _tag: z.literal('never-inspected') }
const unavailable = { _tag: z.literal('unavailable') }
const clientInspection = { coverageState: coverageStateTagSchema.catch('unrecognized') }

const submissionRefShape = {
  channel: submissionChannelV1Schema,
  receiptId: z.string().min(1),
  // The receipt `_tag` of that channel's Submission Receipt.
  state: z.string().min(1),
  trigger: indexNowSubmissionTriggerV1Schema,
  submittedAt: z.iso.datetime(),
}

const outcomeRowProducer = z.strictObject({
  url: z.url(),
  // The newest received Submission of this URL in the window: IndexNow `accepted` or `pending` (HTTP 202), or Google `accepted`.
  // `submittedAt` is when the engine received it.
  submission: z.strictObject(submissionRefShape),
  google: z.discriminatedUnion('_tag', [z.strictObject(inspectedAfter), z.strictObject(notInspectedSince), z.strictObject(neverInspected), z.strictObject(unavailable)]),
})
const outcomeRowClient = z.looseObject({
  url: z.string(),
  submission: z.looseObject(submissionRefShape),
  google: z.discriminatedUnion('_tag', [z.looseObject({ ...inspectedAfter, ...clientInspection }), z.looseObject({ ...notInspectedSince, ...clientInspection }), z.looseObject(neverInspected), z.looseObject(unavailable)]),
})

const outcomePagination = { total: count, limit: count, offset: count, hasMore: z.boolean() }
export const submissionOutcomesV1Schemas = {
  producer: z.strictObject({ window: z.strictObject(windowShape), outcomes: z.array(outcomeRowProducer), pagination: z.strictObject(outcomePagination) }),
  client: z.looseObject({ window: z.looseObject(windowShape), outcomes: z.array(outcomeRowClient), pagination: z.looseObject(outcomePagination) }),
}
export const submissionOutcomesV1Schema = submissionOutcomesV1Schemas.producer

export type SubmissionChannelV1 = z.infer<typeof submissionChannelV1Schema>
export type SubmissionSummaryV1 = z.infer<typeof submissionSummaryV1Schema>
export type SubmissionOutcomesV1 = z.infer<typeof submissionOutcomesV1Schema>
export type SubmissionOutcomeV1 = SubmissionOutcomesV1['outcomes'][number]
