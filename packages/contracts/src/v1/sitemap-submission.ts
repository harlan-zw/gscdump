// Render-ready Sitemap submission to Google for one Site. gscdump.com picks the
// Sitemap and checks its own stored grant, so a consumer never predicts write
// access or filters Sitemap candidates itself.
import { z } from 'zod'
import { defineResponseObject } from './http-core'

/** The Google OAuth scope that lets a stored grant submit a Sitemap. */
export const GSC_SITEMAP_SUBMIT_SCOPE = 'https://www.googleapis.com/auth/webmasters' as const

/** The Search Console permission levels that may submit a Sitemap: Owner and Full. */
export const GSC_SITEMAP_SUBMIT_PERMISSION_LEVELS = ['siteOwner', 'siteFullUser'] as const

const sitemapUrl = z.url({ protocol: /^https?$/ })

/**
 * Whether gscdump can submit a Sitemap to Google for the Site.
 *
 * - `listed`: Google lists `sitemapCount` Sitemaps for the property on
 *   `checkedOn` and has fetched at least one. Nothing to submit.
 * - `awaiting-google`: Google lists `sitemapCount` Sitemaps, such as
 *   `sitemapUrl`, and has fetched none of them yet. Nothing to submit.
 * - `ready`: gscdump found `sitemapUrl` on the Site's own host, under the
 *   linked property, and Google lists no Sitemap. `writeAccess` is `unknown`
 *   when gscdump has no record of the granted scopes; Google then decides.
 * - `needs-write-access`: the stored grant can read Search Console only.
 *   `grantHolder` names the Google account whose grant submits: the caller,
 *   or the Site owner. Only that account can allow Sitemap submission, so a
 *   caller who is not the grant holder asks the Site owner.
 * - `insufficient-permission`: the grant holder's Google account has
 *   `permissionLevel` on the property. Google lets only Owner or Full submit
 *   a Sitemap.
 * - `no-sitemap-found`: Google lists no Sitemap, and gscdump found none on the
 *   Site's own host on `checkedOn`.
 * - `not-checked`: gscdump has not read the Site's Sitemaps yet.
 * - `unavailable`: the stored grant cannot read the property, or the Site
 *   owner has no stored Google grant.
 */
const callerGrantHolder = defineResponseObject({ _tag: z.literal('caller') })
const siteOwnerGrantHolder = defineResponseObject({
  _tag: z.literal('site-owner'),
  email: z.email(),
  name: z.string().min(1).nullable(),
})

/**
 * The Google account whose stored grant submits for the Site: the caller's
 * own, or the Site owner's, with the email and name gscdump stores for it.
 */
export const sitemapGrantHolderV1Schemas = {
  producer: z.discriminatedUnion('_tag', [callerGrantHolder.producer, siteOwnerGrantHolder.producer]),
  client: z.discriminatedUnion('_tag', [callerGrantHolder.client, siteOwnerGrantHolder.client]),
}

const listed = defineResponseObject({
  _tag: z.literal('listed'),
  checkedOn: z.iso.date(),
  sitemapCount: z.number().int().positive(),
})
const awaitingGoogle = defineResponseObject({
  _tag: z.literal('awaiting-google'),
  checkedOn: z.iso.date(),
  sitemapUrl,
  sitemapCount: z.number().int().positive(),
})
const ready = defineResponseObject({
  _tag: z.literal('ready'),
  sitemapUrl,
  writeAccess: z.enum(['granted', 'unknown']),
})
const needsWriteAccessShape = {
  _tag: z.literal('needs-write-access'),
  sitemapUrl,
  requiredScope: z.literal(GSC_SITEMAP_SUBMIT_SCOPE),
}
const needsWriteAccess = defineResponseObject(
  { ...needsWriteAccessShape, grantHolder: sitemapGrantHolderV1Schemas.producer },
  { ...needsWriteAccessShape, grantHolder: sitemapGrantHolderV1Schemas.client },
)
const insufficientPermissionShape = {
  _tag: z.literal('insufficient-permission'),
  sitemapUrl,
  permissionLevel: z.string().min(1),
  requiredPermissionLevels: z.array(z.enum(GSC_SITEMAP_SUBMIT_PERMISSION_LEVELS)).min(1),
}
const insufficientPermission = defineResponseObject(
  { ...insufficientPermissionShape, grantHolder: sitemapGrantHolderV1Schemas.producer },
  { ...insufficientPermissionShape, grantHolder: sitemapGrantHolderV1Schemas.client },
)
const noSitemapFound = defineResponseObject({
  _tag: z.literal('no-sitemap-found'),
  checkedOn: z.iso.date(),
})
const notChecked = defineResponseObject({ _tag: z.literal('not-checked') })
const unavailable = defineResponseObject({
  _tag: z.literal('unavailable'),
  reason: z.enum(['permission-lost', 'grant-missing']),
})

export const sitemapSubmissionStateV1Schemas = {
  producer: z.discriminatedUnion('_tag', [
    listed.producer,
    awaitingGoogle.producer,
    ready.producer,
    needsWriteAccess.producer,
    insufficientPermission.producer,
    noSitemapFound.producer,
    notChecked.producer,
    unavailable.producer,
  ]),
  client: z.discriminatedUnion('_tag', [
    listed.client,
    awaitingGoogle.client,
    ready.client,
    needsWriteAccess.client,
    insufficientPermission.client,
    noSitemapFound.client,
    notChecked.client,
    unavailable.client,
  ]),
}

/**
 * `partner.sites.sitemaps.submission.get`. `callerCanAct` says whether the
 * caller may run `partner.sites.sitemaps.submission.create` for the Site.
 */
export const sitemapSubmissionV1Schemas = defineResponseObject({
  searchEngine: z.literal('google'),
  gscPropertyUrl: z.string().min(1),
  callerCanAct: z.boolean(),
  state: sitemapSubmissionStateV1Schemas.producer,
}, {
  searchEngine: z.literal('google'),
  gscPropertyUrl: z.string().min(1),
  callerCanAct: z.boolean(),
  state: sitemapSubmissionStateV1Schemas.client,
})

/**
 * `partner.sites.sitemaps.submission.create`. gscdump picks the Sitemap, so the
 * request has no body. Every expected outcome is a value:
 *
 * - `submitted`: Google accepted `sitemapUrl` and now lists `sitemapCount` Sitemaps.
 * - `failed`: `reason` repeats the read state that blocked the submit, or says
 *   Google rejected the URL (`rejected`) or could not answer (`provider-unavailable`).
 */
const submitted = defineResponseObject({
  _tag: z.literal('submitted'),
  sitemapUrl,
  sitemapCount: z.number().int().nonnegative(),
})
const failed = defineResponseObject({
  _tag: z.literal('failed'),
  reason: z.enum([
    'already-listed',
    'no-sitemap-found',
    'needs-write-access',
    'insufficient-permission',
    'permission-lost',
    'grant-missing',
    'rejected',
    'provider-unavailable',
  ]),
  retryable: z.boolean(),
  sitemapUrl: sitemapUrl.nullable(),
})

export const sitemapSubmitResultV1Schemas = {
  producer: z.discriminatedUnion('_tag', [submitted.producer, failed.producer]),
  client: z.discriminatedUnion('_tag', [submitted.client, failed.client]),
}

export type SitemapGrantHolderV1 = z.infer<typeof sitemapGrantHolderV1Schemas.producer>
export type SitemapSubmissionStateV1 = z.infer<typeof sitemapSubmissionStateV1Schemas.producer>
export type SitemapSubmissionV1 = z.infer<typeof sitemapSubmissionV1Schemas.producer>
export type SitemapSubmitResultV1 = z.infer<typeof sitemapSubmitResultV1Schemas.producer>
