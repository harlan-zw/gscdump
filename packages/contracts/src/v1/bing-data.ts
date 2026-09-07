import { z } from 'zod'
import { defineResponseObject } from './http-core'

export const bingDataQueryV1Schema = z.strictObject({
  dataset: z.enum(['traffic', 'pages', 'keywords', 'crawl']),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).refine(value => value.endDate >= value.startDate
  && Date.parse(value.endDate) - Date.parse(value.startDate) <= 366 * 86_400_000, {
  message: 'The date range must be ordered and span at most 366 days.',
  path: ['endDate'],
})

const observed = {
  observedAt: z.iso.datetime(),
  providerStartDate: z.iso.date().nullable(),
  providerEndDate: z.iso.date().nullable(),
}
const missing = defineResponseObject({ _tag: z.literal('missing') })
const ready = defineResponseObject({ _tag: z.literal('ready'), ...observed })
const unavailable = defineResponseObject({
  _tag: z.literal('unavailable'),
  ...observed,
  observedAt: z.iso.datetime().nullable(),
  lastAttemptAt: z.iso.datetime(),
  reason: z.string().min(1),
})
const sync = {
  producer: z.discriminatedUnion('_tag', [missing.producer, ready.producer, unavailable.producer]),
  client: z.discriminatedUnion('_tag', [missing.client, ready.client, unavailable.client]),
}
const pagination = defineResponseObject({
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(500),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})
const traffic = defineResponseObject({ date: z.iso.date(), clicks: z.number().nonnegative(), impressions: z.number().nonnegative() })
const positions = { averageClickPosition: z.number().nonnegative().nullable(), averageImpressionPosition: z.number().nonnegative().nullable() }
const pages = defineResponseObject({ ...traffic.producer.shape, page: z.url(), ...positions })
const keywords = defineResponseObject({ ...traffic.producer.shape, keyword: z.string(), ...positions })
const count = z.number().int().nonnegative()
const crawl = defineResponseObject({
  date: z.iso.date(),
  crawledPages: count,
  inIndex: count,
  inLinks: count,
  crawlErrors: count,
  blockedByRobotsTxt: count,
  containsMalware: count,
  code2xx: count,
  code301: count,
  code302: count,
  code4xx: count,
  code5xx: count,
  allOtherCodes: count,
  connectionTimeout: count.nullable(),
  dnsFailures: count.nullable(),
})
function dataset<const D extends string, const S extends string, R extends z.ZodRawShape>(
  name: D,
  semantics: S,
  rows: ReturnType<typeof defineResponseObject<R>>,
): ReturnType<typeof defineResponseObject<{
  searchEngine: z.ZodLiteral<'bing'>
  siteUrl: z.ZodURL
  dataset: z.ZodLiteral<D>
  semantics: z.ZodLiteral<S>
  sync: typeof sync.producer
  rows: z.ZodArray<z.ZodObject<R>>
  pagination: typeof pagination.producer
}>> {
  const common = { searchEngine: z.literal('bing'), siteUrl: z.url(), dataset: z.literal(name), semantics: z.literal(semantics) }
  return defineResponseObject({ ...common, sync: sync.producer, rows: z.array(rows.producer), pagination: pagination.producer }, { ...common, sync: sync.client, rows: z.array(rows.client), pagination: pagination.client })
}
const datasets = [dataset('traffic', 'site-totals', traffic), dataset('pages', 'ranked-pages', pages), dataset('keywords', 'ranked-keywords', keywords), dataset('crawl', 'crawl-statistics', crawl)] as const
export const bingDataV1Schemas = {
  producer: z.discriminatedUnion('dataset', [datasets[0].producer, datasets[1].producer, datasets[2].producer, datasets[3].producer]),
  client: z.discriminatedUnion('dataset', [datasets[0].client, datasets[1].client, datasets[2].client, datasets[3].client]),
}
export type BingDataV1 = z.infer<typeof bingDataV1Schemas.producer>
export type BingDataQueryV1 = z.infer<typeof bingDataQueryV1Schema>
