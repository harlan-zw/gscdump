// Render-ready IndexNow fleet state for every Site a user can see. Read from
// D1 in one fleet request so dashboards do not fan out per Site.
import { z } from 'zod'
import { defineResponseObject } from './http-core'
import { indexNowConnectionV1Schemas, indexNowSubmissionTriggerV1Schema } from './indexnow'

const isoDateTime = z.iso.datetime()
const calendarDate = z.iso.date()
const publicSiteId = z.string().regex(/^s_[\w-]+$/)
const publicTeamId = z.string().regex(/^t_[\w-]+$/)
const count = z.number().int().nonnegative()

/** The query of `partner.users.indexing.indexnow.sites.list`. */
export const indexNowSitesQueryV1Schema = z.strictObject({
  teamId: publicTeamId.optional(),
})

/** Compact latest Submission Receipt for fleet cards without full URL arrays. */
export const indexNowLatestReceiptSummaryV1Schemas = defineResponseObject({
  _tag: z.enum(['queued', 'accepted', 'pending', 'rejected', 'retrying', 'failed']),
  id: z.string().min(1),
  trigger: indexNowSubmissionTriggerV1Schema,
  urlCount: count,
  httpStatus: z.number().int().min(100).max(599).nullable(),
  reason: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  retryAt: isoDateTime.nullable(),
})

/** One trailing week of IndexNow Submission outcomes for a Site. */
export const indexNowWeekSummaryV1Schemas = defineResponseObject({
  weekStart: calendarDate,
  acceptedUrls: count,
  acceptedCount: count,
  failedCount: count,
  retryingCount: count,
})

const indexNowSiteBase = {
  siteId: publicSiteId,
  siteUrl: z.string().min(1),
  teamId: publicTeamId.nullable(),
  acceptedUrls30d: count,
}

/** One Site in the IndexNow fleet. */
export const indexNowSiteV1Schemas = defineResponseObject({
  ...indexNowSiteBase,
  connection: indexNowConnectionV1Schemas.producer,
  latestReceipt: indexNowLatestReceiptSummaryV1Schemas.producer.nullable(),
  weekly: z.array(indexNowWeekSummaryV1Schemas.producer),
}, {
  ...indexNowSiteBase,
  connection: indexNowConnectionV1Schemas.client,
  latestReceipt: indexNowLatestReceiptSummaryV1Schemas.client.nullable(),
  weekly: z.array(indexNowWeekSummaryV1Schemas.client),
})

/** `partner.users.indexing.indexnow.sites.list`: IndexNow state for every Site the user can see. */
export const indexNowSitesV1Schemas = defineResponseObject({
  sites: z.array(indexNowSiteV1Schemas.producer),
}, {
  sites: z.array(indexNowSiteV1Schemas.client),
})

export type IndexNowSitesQueryV1 = z.infer<typeof indexNowSitesQueryV1Schema>
export type IndexNowLatestReceiptSummaryV1 = z.infer<typeof indexNowLatestReceiptSummaryV1Schemas.producer>
export type IndexNowWeekSummaryV1 = z.infer<typeof indexNowWeekSummaryV1Schemas.producer>
export type IndexNowSiteV1 = z.infer<typeof indexNowSiteV1Schemas.producer>
export type IndexNowSitesV1 = z.infer<typeof indexNowSitesV1Schemas.producer>
