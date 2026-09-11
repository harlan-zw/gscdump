import type { GoogleSearchConsoleClient, SearchAnalyticsQuery } from 'gscdump'
import { runGscSyncSlice } from '@gscdump/engine-gsc-api'
import { describe, expect, it } from 'vitest'

describe('registered host scope', () => {
  it.each(['example.com', 'www.example.com', 'blog.example.com'])('only selects URLs on %s', async (domain) => {
    const queries: SearchAnalyticsQuery[] = []
    const client = {
      searchAnalytics: {
        query: async (_site: string, query: SearchAnalyticsQuery) => {
          queries.push(query)
          return { rows: [] }
        },
      },
    } as unknown as GoogleSearchConsoleClient

    await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      domainFilter: { domain },
      table: 'pages',
      startDate: '2026-09-01',
      endDate: '2026-09-01',
      onBatch: async () => {},
    })

    const filter = queries[0]!.dimensionFilterGroups![0]!.filters!.find(filter => filter.dimension === 'page')!
    const matches = new RegExp(filter.expression)
    const candidates = ['example.com', 'www.example.com', 'blog.example.com', 'www.blog.example.com', 'exampleXcom', 'example.com.evil.test']
    for (const host of candidates) {
      expect(matches.test(`https://${host}/page`), host).toBe(host === domain)
      expect(matches.test(`http://${host}/page`), host).toBe(host === domain)
    }
  })
})
