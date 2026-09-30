// Render-ready Bing state for every Site a user can see. gscdump.com applies
// the linking and sitemap rules, so a consumer renders the tag it receives and
// calls the Operation that tag names.
import { z } from 'zod'
import { bingCnameVerificationV1Schema } from './bing'
import { defineResponseObject } from './http-core'

const isoDateTime = z.iso.datetime()
const publicSiteId = z.string().regex(/^s_[\w-]+$/)
const publicTeamId = z.string().regex(/^t_[\w-]+$/)
const remoteSiteUrl = z.url()
const count = z.number().int().nonnegative()

/** The query of `partner.users.indexing.bing.sites.list`. */
export const bingSitesQueryV1Schema = z.strictObject({
  teamId: publicTeamId.optional(),
})

/** One Sitemap as Bing listed it at `checkedAt`. `status` is Bing's own word. */
const bingListedSitemap = defineResponseObject({
  url: z.string().min(1),
  status: z.string(),
  submittedAt: isoDateTime.nullable(),
  lastCrawledAt: isoDateTime.nullable(),
  urlCount: count.nullable(),
})

/**
 * What Bing knows about a collecting Site's Sitemaps.
 *
 * - `submitted`: Bing lists `sitemapCount` Sitemaps. `urlCount` sums the counts
 *   Bing reports, or is null when Bing reports none. `lastCrawledAt` is the
 *   newest crawl.
 * - `missing`: Bing lists none, and gscdump has not submitted one in the last
 *   72 hours. Submit one.
 * - `awaiting-bing`: gscdump submitted a Sitemap at `lastSubmittedAt`, in the
 *   last 72 hours, and Bing does not list it yet. Bing lags after it accepts
 *   one, so do not submit it again.
 * - `unknown`: gscdump has no successful read. Never prompt a submit.
 */
const submittedSitemaps = defineResponseObject({
  _tag: z.literal('submitted'),
  checkedAt: isoDateTime,
  sitemapCount: z.number().int().positive(),
  urlCount: count.nullable(),
  lastCrawledAt: isoDateTime.nullable(),
  sitemaps: z.array(bingListedSitemap.producer).min(1),
}, {
  _tag: z.literal('submitted'),
  checkedAt: isoDateTime,
  sitemapCount: z.number().int().positive(),
  urlCount: count.nullable(),
  lastCrawledAt: isoDateTime.nullable(),
  sitemaps: z.array(bingListedSitemap.client).min(1),
})
const missingSitemaps = defineResponseObject({
  _tag: z.literal('missing'),
  checkedAt: isoDateTime,
  lastSubmittedAt: isoDateTime.nullable(),
})
const awaitingBingSitemaps = defineResponseObject({
  _tag: z.literal('awaiting-bing'),
  checkedAt: isoDateTime.nullable(),
  lastSubmittedAt: isoDateTime,
})
const unknownSitemaps = defineResponseObject({ _tag: z.literal('unknown') })

export const bingSitemapViewV1Schemas = {
  producer: z.discriminatedUnion('_tag', [submittedSitemaps.producer, missingSitemaps.producer, awaitingBingSitemaps.producer, unknownSitemaps.producer]),
  client: z.discriminatedUnion('_tag', [submittedSitemaps.client, missingSitemaps.client, awaitingBingSitemaps.client, unknownSitemaps.client]),
}

/**
 * One Site's Bing state. Each tag names one next step:
 *
 * - `collecting`: gscdump collects Bing data. The next step is a Sitemap
 *   submit when `sitemap` reads `missing`.
 * - `verification-required`: add the CNAME record, then verify.
 * - `linkable`: the Site owner's Bing grant works, so a link binds the Site
 *   with no Microsoft redirect. `reason` says why the Site is not collecting:
 *   it was never linked, its binding stalled before the grant was renewed, or
 *   Bing stopped listing it for the account.
 * - `grant-required`: the Site is not linked, and the Site owner must authorize
 *   Bing first. `reason` says whether no grant exists or Microsoft stopped
 *   accepting it.
 * - `reauthorization-required`: the Site was linked, and Microsoft stopped
 *   accepting the Site owner's grant. Authorize Bing again.
 * - `unavailable`: gscdump does not offer Bing for this Site's owner yet.
 */
const collectingState = defineResponseObject({
  _tag: z.literal('collecting'),
  remoteSiteUrl,
  lastEvidenceAt: isoDateTime.nullable(),
  sitemap: bingSitemapViewV1Schemas.producer,
}, {
  _tag: z.literal('collecting'),
  remoteSiteUrl,
  lastEvidenceAt: isoDateTime.nullable(),
  sitemap: bingSitemapViewV1Schemas.client,
})
const verificationRequiredState = defineResponseObject({
  _tag: z.literal('verification-required'),
  remoteSiteUrl,
  verification: bingCnameVerificationV1Schema,
})
const linkableState = defineResponseObject({
  _tag: z.literal('linkable'),
  reason: z.enum(['not-linked', 'binding-stalled', 'permission-lost']),
})
const grantRequiredState = defineResponseObject({
  _tag: z.literal('grant-required'),
  reason: z.enum(['grant-missing', 'reauthorization-required']),
})
const reauthorizationRequiredState = defineResponseObject({
  _tag: z.literal('reauthorization-required'),
  remoteSiteUrl,
})
const unavailableState = defineResponseObject({
  _tag: z.literal('unavailable'),
  reason: z.enum(['not-enabled']),
})

export const bingSiteStateV1Schemas = {
  producer: z.discriminatedUnion('_tag', [
    collectingState.producer,
    verificationRequiredState.producer,
    linkableState.producer,
    grantRequiredState.producer,
    reauthorizationRequiredState.producer,
    unavailableState.producer,
  ]),
  client: z.discriminatedUnion('_tag', [
    collectingState.client,
    verificationRequiredState.client,
    linkableState.client,
    grantRequiredState.client,
    reauthorizationRequiredState.client,
    unavailableState.client,
  ]),
}

/**
 * One Site in the Bing fleet. `callerCanAct` says whether the caller may run
 * the Operation the state names: only the Site owner may link or authorize
 * Bing, and a caller who manages the Site may verify it or submit a Sitemap.
 */
export const bingSiteV1Schemas = defineResponseObject({
  siteId: publicSiteId,
  siteUrl: z.string().min(1),
  teamId: publicTeamId.nullable(),
  callerCanAct: z.boolean(),
  state: bingSiteStateV1Schemas.producer,
}, {
  siteId: publicSiteId,
  siteUrl: z.string().min(1),
  teamId: publicTeamId.nullable(),
  callerCanAct: z.boolean(),
  state: bingSiteStateV1Schemas.client,
})

/** The user's one Bing grant, which serves every Site they own. */
const authorizedGrant = defineResponseObject({ _tag: z.literal('authorized'), scopes: z.array(z.string().min(1)) })
const reauthorizationRequiredGrant = defineResponseObject({ _tag: z.literal('reauthorization-required') })
const missingGrant = defineResponseObject({ _tag: z.literal('missing') })

export const bingGrantV1Schemas = {
  producer: z.discriminatedUnion('_tag', [authorizedGrant.producer, reauthorizationRequiredGrant.producer, missingGrant.producer]),
  client: z.discriminatedUnion('_tag', [authorizedGrant.client, reauthorizationRequiredGrant.client, missingGrant.client]),
}

/** `partner.users.indexing.bing.sites.list`: the user's grant and every Site they can see. */
export const bingSitesV1Schemas = defineResponseObject({
  searchEngine: z.literal('bing'),
  grant: bingGrantV1Schemas.producer,
  sites: z.array(bingSiteV1Schemas.producer),
}, {
  searchEngine: z.literal('bing'),
  grant: bingGrantV1Schemas.client,
  sites: z.array(bingSiteV1Schemas.client),
})

/**
 * `partner.sites.indexing.bing.link.create`. Every expected outcome is a value:
 * `linked` carries the Site's new state, `grant-required` sends the owner to
 * authorize Bing, and `failed` says whether a retry can help.
 */
const linkedResult = defineResponseObject({ _tag: z.literal('linked'), site: bingSiteV1Schemas.producer }, { _tag: z.literal('linked'), site: bingSiteV1Schemas.client })
const linkGrantRequiredResult = defineResponseObject({
  _tag: z.literal('grant-required'),
  reason: z.enum(['grant-missing', 'reauthorization-required']),
})
const linkFailedResult = defineResponseObject({
  _tag: z.literal('failed'),
  reason: z.enum(['sites-forbidden', 'sites-throttled', 'sites-unavailable', 'oauth-contract']),
  retryable: z.boolean(),
})

export const bingLinkResultV1Schemas = {
  producer: z.discriminatedUnion('_tag', [linkedResult.producer, linkGrantRequiredResult.producer, linkFailedResult.producer]),
  client: z.discriminatedUnion('_tag', [linkedResult.client, linkGrantRequiredResult.client, linkFailedResult.client]),
}

/**
 * The body of `partner.sites.indexing.bing.authorization.create`. gscdump
 * returns the browser to `returnUrl` with `bing=connected`,
 * `bing=verification-required`, or `bing=error&reason=<reason>`. It must be a
 * gscdump.com path or an origin gscdump.com allows.
 */
export const bingAuthorizationRequestV1Schema = z.strictObject({
  returnUrl: z.string().min(1).max(2_048).optional(),
})

export const bingAuthorizationV1Schemas = defineResponseObject({
  authorizeUrl: z.url(),
  expiresAt: isoDateTime,
})

/** The body of `partner.sites.indexing.bing.sitemaps.submit`. Without `url`, gscdump submits the Sitemap it finds on the Site. */
export const bingSitemapSubmitRequestV1Schema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2_048).optional(),
})

const bingSitemapSubmittedResult = defineResponseObject({
  _tag: z.literal('submitted'),
  sitemapUrl: z.url(),
  sitemap: bingSitemapViewV1Schemas.producer,
}, {
  _tag: z.literal('submitted'),
  sitemapUrl: z.url(),
  sitemap: bingSitemapViewV1Schemas.client,
})
const bingSitemapFailedResult = defineResponseObject({
  _tag: z.literal('failed'),
  reason: z.enum(['site-unverified', 'grant-required', 'no-sitemap-found', 'throttled', 'provider-unavailable']),
  retryable: z.boolean(),
})

/** `partner.sites.indexing.bing.sitemaps.submit`. Bing lags after a submit, so `sitemap` usually reads `awaiting-bing`. */
export const bingSitemapSubmitResultV1Schemas = {
  producer: z.discriminatedUnion('_tag', [bingSitemapSubmittedResult.producer, bingSitemapFailedResult.producer]),
  client: z.discriminatedUnion('_tag', [bingSitemapSubmittedResult.client, bingSitemapFailedResult.client]),
}

export type BingSitesQueryV1 = z.infer<typeof bingSitesQueryV1Schema>
export type BingSitemapViewV1 = z.infer<typeof bingSitemapViewV1Schemas.producer>
export type BingSiteStateV1 = z.infer<typeof bingSiteStateV1Schemas.producer>
export type BingSiteV1 = z.infer<typeof bingSiteV1Schemas.producer>
export type BingGrantV1 = z.infer<typeof bingGrantV1Schemas.producer>
export type BingSitesV1 = z.infer<typeof bingSitesV1Schemas.producer>
export type BingLinkResultV1 = z.infer<typeof bingLinkResultV1Schemas.producer>
export type BingAuthorizationRequestV1 = z.infer<typeof bingAuthorizationRequestV1Schema>
export type BingAuthorizationV1 = z.infer<typeof bingAuthorizationV1Schemas.producer>
export type BingSitemapSubmitRequestV1 = z.infer<typeof bingSitemapSubmitRequestV1Schema>
export type BingSitemapSubmitResultV1 = z.infer<typeof bingSitemapSubmitResultV1Schemas.producer>
