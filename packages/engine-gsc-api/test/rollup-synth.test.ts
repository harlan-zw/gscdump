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

    const rows = await fetchGscTopN({
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
    expect(rows[0]!.sum_position).toBe(4)
  })

  it('passes explicit searchType to daily GSC queries', async () => {
    const captured: CapturedQuery[] = []
    const client = makeClient(captured, [
      { date: '2026-05-10', clicks: 1, impressions: 2, position: 3 },
    ])

    const rows = await fetchGscDaily({
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
    expect(rows[0]!.sum_position).toBe(4)
  })

  it('keeps a stable bounded top-N for dimensions without server ordering', async () => {
    const client = makeClient([], [
      { page: 'a', clicks: 5, impressions: 10, position: 2 },
      { page: 'b', clicks: 20, impressions: 30, position: 3 },
      { page: 'c', clicks: 20, impressions: 40, position: 4 },
      { page: 'd', clicks: 10, impressions: 20, position: 5 },
    ])

    const rows = await fetchGscTopN({
      client,
      siteUrl: 'sc-domain:example.com',
      dimension: pageDim,
      range: { start: '2026-05-10', end: '2026-05-12' },
      sliceTop: 3,
    })

    expect(rows.map(row => row.key)).toEqual(['b', 'c', 'd'])
  })

  it('stops mapping server-ordered rows after collecting the requested top-N', async () => {
    const client = makeClient([], [
      { page: '', clicks: 100, impressions: 100, position: 1 },
      { page: 'a', clicks: 20, impressions: 30, position: 2 },
      { page: 'b', clicks: 10, impressions: 20, position: 3 },
      { page: 'c', clicks: 5, impressions: 10, position: 4 },
    ])

    const rows = await fetchGscTopN({
      client,
      siteUrl: 'sc-domain:example.com',
      dimension: pageDim,
      range: { start: '2026-05-10', end: '2026-05-12' },
      orderByClicksDesc: true,
      sliceTop: 2,
    })

    expect(rows.map(row => row.key)).toEqual(['a', 'b'])
  })

  it('preserves stable full-sort behavior for malformed non-finite click metrics', async () => {
    const client = makeClient([], [
      { page: 'a', clicks: Number.NaN, impressions: 10, position: 2 },
      { page: 'b', clicks: 20, impressions: 30, position: 3 },
      { page: 'c', clicks: 10, impressions: 20, position: 4 },
    ])

    const rows = await fetchGscTopN({
      client,
      siteUrl: 'sc-domain:example.com',
      dimension: pageDim,
      range: { start: '2026-05-10', end: '2026-05-12' },
      sliceTop: 2,
    })

    expect(rows.map(row => row.key)).toEqual(['a', 'b'])
  })
})
