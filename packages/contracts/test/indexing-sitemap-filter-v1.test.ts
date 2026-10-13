import { INDEXING_SITEMAP_FILTER_MAX_FEEDS, indexingDiagnosticsParamsSchema, indexingUrlsParamsSchema } from '@gscdump/contracts'
import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const { getSiteIndexing, getSiteIndexingDiagnostics, listSiteIndexingUrls } = createGscdumpV1Protocol().surfaces.partner.operations
const reads = [
  ['summary', getSiteIndexing.request.query],
  ['urls', listSiteIndexingUrls.request.query],
  ['diagnostics', getSiteIndexingDiagnostics.request.query],
] as const

const retired = 'https://example.com/__sitemap__/retired-0.xml'
const pages = 'https://example.com/__sitemap__/pages.xml'

describe('indexing Sitemap filter v1', () => {
  it.each(reads)('%s accepts one Sitemap or a repeated query value', (_name, query) => {
    expect(query.parse({ feedpath: retired })).toMatchObject({ feedpath: retired })
    expect(query.parse({ excludeFeedpath: [retired, pages] })).toMatchObject({ excludeFeedpath: [retired, pages] })
  })

  it.each(reads)('%s refuses feedpath with excludeFeedpath', (_name, query) => {
    const result = query.safeParse({ feedpath: pages, excludeFeedpath: retired })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['excludeFeedpath'])
  })

  it.each(reads)('%s refuses an empty list and an oversized list', (_name, query) => {
    const tooMany = Array.from({ length: INDEXING_SITEMAP_FILTER_MAX_FEEDS + 1 }, (_, index) => `https://example.com/sitemap-${index}.xml`)
    expect(query.safeParse({ feedpath: [] }).success).toBe(false)
    expect(query.safeParse({ feedpath: '' }).success).toBe(false)
    expect(query.safeParse({ excludeFeedpath: tooMany }).success).toBe(false)
  })

  it('keeps the legacy partner client schemas on the same rule', () => {
    expect(indexingUrlsParamsSchema.parse({ limit: 5, feedpath: [pages] })).toEqual({ limit: 5, feedpath: [pages] })
    expect(indexingDiagnosticsParamsSchema.safeParse({ feedpath: pages, excludeFeedpath: retired }).success).toBe(false)
  })
})
