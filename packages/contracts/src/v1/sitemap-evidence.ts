import { z } from 'zod'
import { defineResponseObject } from './http-core'

const sitemapUrl = z.url({ protocol: /^https?$/ }).max(2_048).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.hash
}, 'Use a Sitemap URL without credentials or a fragment.')

export const sitemapInspectQueryV1Schema = z.strictObject({
  searchEngine: z.enum(['google', 'bing']),
  url: sitemapUrl,
})

const captured = defineResponseObject({
  _tag: z.literal('captured'),
  source: z.enum(['live', 'stored']),
  capturedAt: z.iso.datetime(),
})
const unavailableCapture = defineResponseObject({ _tag: z.literal('unavailable') })
const missing = defineResponseObject({ _tag: z.literal('missing') })
const unavailable = defineResponseObject({
  _tag: z.literal('unavailable'),
  reason: z.enum(['grant-missing', 'reauthorization-required', 'permission-lost', 'site-unverified', 'not-enabled', 'not-checked', 'throttled', 'provider-unavailable']),
  retryable: z.boolean(),
})
const googleListed = defineResponseObject({
  _tag: z.literal('listed'),
  lastSubmitted: z.iso.datetime({ offset: true }).nullable(),
  lastDownloaded: z.iso.datetime({ offset: true }).nullable(),
  isPending: z.boolean(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  urlCount: z.number().int().nonnegative().nullable(),
})
const bingListed = defineResponseObject({
  _tag: z.literal('listed'),
  status: z.string(),
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
  lastCrawledAt: z.iso.datetime({ offset: true }).nullable(),
  urlCount: z.number().int().nonnegative().nullable(),
})

const google = defineResponseObject({
  searchEngine: z.literal('google'),
  sitemapUrl,
  capture: captured.producer,
  state: z.discriminatedUnion('_tag', [googleListed.producer, missing.producer]),
}, {
  searchEngine: z.literal('google'),
  sitemapUrl,
  capture: captured.client,
  state: z.discriminatedUnion('_tag', [googleListed.client, missing.client]),
})
const bing = defineResponseObject({
  searchEngine: z.literal('bing'),
  sitemapUrl,
  capture: captured.producer,
  state: z.discriminatedUnion('_tag', [bingListed.producer, missing.producer]),
}, {
  searchEngine: z.literal('bing'),
  sitemapUrl,
  capture: captured.client,
  state: z.discriminatedUnion('_tag', [bingListed.client, missing.client]),
})
const failed = defineResponseObject({
  searchEngine: z.enum(['google', 'bing']),
  sitemapUrl,
  capture: unavailableCapture.producer,
  state: unavailable.producer,
}, {
  searchEngine: z.enum(['google', 'bing']),
  sitemapUrl,
  capture: unavailableCapture.client,
  state: unavailable.client,
})

/** Exact provider listing evidence. Missing requires a successful dated read. */
export const sitemapEvidenceV1Schemas = {
  producer: z.union([google.producer, bing.producer, failed.producer]),
  client: z.union([google.client, bing.client, failed.client]),
}

export type SitemapInspectQueryV1 = z.infer<typeof sitemapInspectQueryV1Schema>
export type SitemapEvidenceV1 = z.infer<typeof sitemapEvidenceV1Schemas.producer>
