// Wire shapes for partner billing modes. gscdump.com ADR-0014 records the decision.
import { z } from 'zod'

/**
 * Why gscdump holds a Site and does not start its Backfill. Stored per Site.
 *
 * - `size_limit`: the Site adds more query×page rows per day than the size limit.
 * - `sitemap_limit`: the Site lists more sitemap URLs than the limit.
 * - `size_unknown`: gscdump could not measure the Site size.
 * - `size_pending`: gscdump queued another size measurement.
 */
export const SITE_HOLD_REASONS = [
  'size_limit',
  'sitemap_limit',
  'size_unknown',
  'size_pending',
] as const

export type SiteHoldReason = typeof SITE_HOLD_REASONS[number]

export const siteHoldReasonSchema = z.enum(SITE_HOLD_REASONS)

/**
 * The `details.reason` values of a v1 error envelope that refuses work because
 * of an entitlement. The HTTP status and the v1 `code` stay the only branch
 * for generic handling; `reason` names the entitlement.
 */
export const ENTITLEMENT_REFUSAL_REASONS = [
  'site_allowance',
  'duplicate_property',
  'site_held',
  'inspection_off',
  'inspection_allowance',
] as const

export type EntitlementRefusalReason = typeof ENTITLEMENT_REFUSAL_REASONS[number]

const count = z.number().int().nonnegative()

/**
 * The `details` of a v1 error envelope that refuses work because of an
 * entitlement.
 *
 * - `site_allowance` (409 `invalid_request`): the Billing owner uses all `limit` Sites of the Site allowance.
 * - `duplicate_property` (409 `invalid_request`): the property is already a Site, as `siteUrl`.
 * - `site_held` (409 `invalid_request`): gscdump holds the Site for the `hold` reason.
 * - `inspection_off` (409 `invalid_request`): URL Inspection is off for the Site.
 * - `inspection_allowance` (429 `rate_limited`): the Billing owner used `limit`
 *   URL Inspections this month. The allowance resets on `resetsAt` (`YYYY-MM-DD`, UTC).
 *
 * Unknown `details` keys are dropped, so a newer host can add keys.
 */
export const entitlementRefusalSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('site_allowance'), limit: count }),
  z.object({ reason: z.literal('duplicate_property'), siteUrl: z.string().min(1) }),
  z.object({ reason: z.literal('site_held'), hold: siteHoldReasonSchema }),
  z.object({ reason: z.literal('inspection_off') }),
  z.object({ reason: z.literal('inspection_allowance'), limit: count, resetsAt: z.iso.date() }),
])

export type EntitlementRefusal = z.infer<typeof entitlementRefusalSchema>

/**
 * Read an entitlement refusal from the `details` of a v1 error envelope, such
 * as `GscdumpV1Error.details`. Returns `null` when the details describe a
 * different failure, or a refusal this contract version does not know.
 */
export function parseEntitlementRefusal(details: unknown): EntitlementRefusal | null {
  const parsed = entitlementRefusalSchema.safeParse(details)
  return parsed.success ? parsed.data : null
}

/** The Meters an allowance notice reports on. */
export const ALLOWANCE_NOTICE_METERS = ['sites', 'preserved_rows', 'url_inspections'] as const

export type AllowanceNoticeMeter = typeof ALLOWANCE_NOTICE_METERS[number]

/** The percentages of a free allowance that send a notice. */
export const ALLOWANCE_NOTICE_THRESHOLDS = [80, 100] as const

export type AllowanceNoticeThreshold = typeof ALLOWANCE_NOTICE_THRESHOLDS[number]

/**
 * The `data` of a `user.allowance.notice` webhook. gscdump sends it to a
 * metered partner when a Billing owner's usage of one Meter reaches
 * `threshold` percent of its free allowance in `period` (`YYYY-MM`, UTC).
 * The partner sends its own notice to the user; gscdump sends none.
 */
export const userAllowanceNoticeDataSchema = z.object({
  userId: z.string().regex(/^u_[\w-]+$/),
  meter: z.enum(ALLOWANCE_NOTICE_METERS),
  threshold: z.literal(ALLOWANCE_NOTICE_THRESHOLDS),
  used: count,
  allowance: count,
  period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
})

export type UserAllowanceNoticeData = z.infer<typeof userAllowanceNoticeDataSchema>
