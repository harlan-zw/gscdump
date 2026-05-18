import type { GoogleSearchConsoleClient, SearchAnalyticsQuery, SearchAnalyticsResponse } from 'gscdump'
import { describe, expect, it } from 'vitest'
import { runGscSyncSlice } from '../src/sync-slice'

function makeClient(
  responses: SearchAnalyticsResponse[],
  capturedQueries: SearchAnalyticsQuery[],
): GoogleSearchConsoleClient {
  let i = 0
  return {
    _rawQuery: async (_siteUrl: string, body: SearchAnalyticsQuery) => {
      capturedQueries.push(body)
      const r = responses[i] ?? { rows: [] }
      i++
      return r
    },
  } as unknown as GoogleSearchConsoleClient
}

describe('runGscSyncSlice', () => {
  it('passes custom dimensions and dataState through to the GSC query', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([{ rows: [] }], captured)
    const onBatch = async () => {}

    await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'hourly_pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      dimensions: ['hour', 'page'],
      dataState: 'hourly_all',
      onBatch,
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.dimensions).toEqual(['hour', 'page'])
    expect(captured[0]!.dataState).toBe('hourly_all')
  })

  it('defaults to DIMENSIONS_BY_TABLE + dataState=all', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([{ rows: [] }], captured)

    await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      onBatch: async () => {},
    })

    expect(captured[0]!.dimensions).toEqual(['page', 'date'])
    expect(captured[0]!.dataState).toBe('all')
  })

  it('defaults hourly_pages dimensions to [hour, page]', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([{ rows: [] }], captured)

    await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'hourly_pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      onBatch: async () => {},
    })

    expect(captured[0]!.dimensions).toEqual(['hour', 'page'])
  })

  it('returns metadata captured from the final page', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const responses: SearchAnalyticsResponse[] = [
      { rows: [], metadata: { first_incomplete_hour: '2026-05-17T15:00:00-07:00' } as unknown as never } as SearchAnalyticsResponse,
    ]
    const client = makeClient(responses, captured)

    const result = await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'hourly_pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      dataState: 'hourly_all',
      onBatch: async () => {},
    })

    expect(result.metadata?.first_incomplete_hour).toBe('2026-05-17T15:00:00-07:00')
    expect(result.hasMore).toBe(false)
  })

  it('keeps last seen metadata across multiple paged responses', async () => {
    const rowLimit = 2
    const fullPage = [
      { keys: ['a'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
      { keys: ['b'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
    ]
    const responses = [
      { rows: fullPage, metadata: { first_incomplete_hour: 'OLD' } } as unknown as SearchAnalyticsResponse,
      { rows: [{ keys: ['c'], clicks: 1, impressions: 1, ctr: 1, position: 1 }], metadata: { first_incomplete_hour: 'NEW' } } as unknown as SearchAnalyticsResponse,
    ]
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient(responses, captured)

    const result = await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'hourly_pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      dataState: 'hourly_all',
      rowLimit,
      onBatch: async () => {},
    })

    expect(result.metadata?.first_incomplete_hour).toBe('NEW')
  })
})
