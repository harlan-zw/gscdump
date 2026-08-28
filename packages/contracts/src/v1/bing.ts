import { z } from 'zod'

const bingSearchEngineSchema = z.literal('bing')
const bingRemoteSiteUrlSchema = z.url()
const bingVerifiedMetadataShape = {
  scopes: z.array(z.string().min(1)),
  tokenExpiresAt: z.iso.datetime().nullable(),
  lastEvidenceAt: z.iso.datetime().nullable(),
}

export const bingCnameVerificationV1Schema = z.strictObject({
  _tag: z.literal('cname'),
  name: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  value: z.literal('verify.bing.com'),
})

export const bingConnectionV1Schema = z.discriminatedUnion('_tag', [
  z.strictObject({
    _tag: z.literal('disconnected'),
    searchEngine: bingSearchEngineSchema,
  }),
  z.strictObject({
    _tag: z.literal('verification-required'),
    searchEngine: bingSearchEngineSchema,
    remoteSiteUrl: bingRemoteSiteUrlSchema,
    verified: z.literal(false),
    verification: bingCnameVerificationV1Schema,
  }),
  z.strictObject({
    _tag: z.literal('connected'),
    searchEngine: bingSearchEngineSchema,
    remoteSiteUrl: bingRemoteSiteUrlSchema,
    verified: z.literal(true),
    ...bingVerifiedMetadataShape,
  }),
  z.strictObject({
    _tag: z.literal('reauthorization-required'),
    searchEngine: bingSearchEngineSchema,
    remoteSiteUrl: bingRemoteSiteUrlSchema,
    verified: z.boolean(),
    ...bingVerifiedMetadataShape,
  }),
  z.strictObject({
    _tag: z.literal('unavailable'),
    searchEngine: bingSearchEngineSchema,
    remoteSiteUrl: bingRemoteSiteUrlSchema,
    verified: z.literal(true),
    reason: z.literal('permission-lost'),
    ...bingVerifiedMetadataShape,
  }),
])

const bingCnameVerificationV1ClientSchema = z.looseObject({
  _tag: z.literal('cname'),
  name: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  value: z.literal('verify.bing.com'),
})

const bingConnectionV1ClientSchema = z.discriminatedUnion('_tag', [
  z.looseObject({
    _tag: z.literal('disconnected'),
    searchEngine: bingSearchEngineSchema,
  }),
  z.looseObject({
    _tag: z.literal('verification-required'),
    searchEngine: bingSearchEngineSchema,
    remoteSiteUrl: bingRemoteSiteUrlSchema,
    verified: z.literal(false),
    verification: bingCnameVerificationV1ClientSchema,
  }),
  z.looseObject({
    _tag: z.literal('connected'),
    searchEngine: bingSearchEngineSchema,
    remoteSiteUrl: bingRemoteSiteUrlSchema,
    verified: z.literal(true),
    ...bingVerifiedMetadataShape,
  }),
  z.looseObject({
    _tag: z.literal('reauthorization-required'),
    searchEngine: bingSearchEngineSchema,
    remoteSiteUrl: bingRemoteSiteUrlSchema,
    verified: z.boolean(),
    ...bingVerifiedMetadataShape,
  }),
  z.looseObject({
    _tag: z.literal('unavailable'),
    searchEngine: bingSearchEngineSchema,
    remoteSiteUrl: bingRemoteSiteUrlSchema,
    verified: z.literal(true),
    reason: z.literal('permission-lost'),
    ...bingVerifiedMetadataShape,
  }),
])

export const bingConnectionV1Schemas = {
  producer: bingConnectionV1Schema,
  client: bingConnectionV1ClientSchema,
} as const

export type BingCnameVerificationV1 = z.infer<typeof bingCnameVerificationV1Schema>
export type BingConnectionV1 = z.infer<typeof bingConnectionV1Schema>
