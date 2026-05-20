import type { GoogleSearchConsoleClient } from 'gscdump'
import { page as pageDim } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { fetchGscDaily, fetchGscTopN } from '../src/rollup-synth'

interface CapturedQuery {
  type?: string
  dimensions?: string[]
  startDate?: string
  endDate?: string
}

function makeClient(captured: CapturedQuery[], rows: Record<string, unknown>[]): GoogleSearchConsoleClient {
  return {
    async* query(_siteUrl: string, builder: { toBody: () => CapturedQuery }) {
      captured.push(builder.toBody())
      yield rows as never
      return {}
    },
  } as unknown as GoogleSearchConsoleClient
}

describe('rollup live synthesis', () => {
  it('passes explicit searchType to top-n GSC queries', async () => {
    const captured: CapturedQuery[] = []
    const client = makeClient(captured, [
      { page: 'https://example.com/', clicks: 1, impressions: 2, position: 3 },
    ])

    await fetchGscTopN({
      client,
      siteUrl: 'sc-domain:example.com',
      dimension: pageDim,
      range: { start: '2026-05-10', end: '2026-05-12' },
      searchType: 'discover',
    })

    expect(captured[0]).toMatchObject({
      type: 'discover',
      dimensions: ['page'],
      startDate: '2026-05-10',
      endDate: '2026-05-12',
    })
  })

  it('passes explicit searchType to daily GSC queries', async () => {
    const captured: CapturedQuery[] = []
    const client = makeClient(captured, [
      { date: '2026-05-10', clicks: 1, impressions: 2, position: 3 },
    ])

    await fetchGscDaily({
      client,
      siteUrl: 'sc-domain:example.com',
      range: { start: '2026-05-10', end: '2026-05-12' },
      searchType: 'image',
    })

    expect(captured[0]).toMatchObject({
      type: 'image',
      dimensions: ['date'],
      startDate: '2026-05-10',
      endDate: '2026-05-12',
    })
  })
})
