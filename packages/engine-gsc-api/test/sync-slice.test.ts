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

  const fullPage2 = [
    { keys: ['a'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
    { keys: ['b'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
  ]

  it('does NOT advance the cursor when a durable onBatch write times out', async () => {
    // Regression: a timed-out onBatch write is ambiguous — the rows may never
    // have been persisted. The slice must stop and let the continuation
    // re-process THIS page from the same cursor, not skip past it.
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([{ rows: fullPage2 }, { rows: fullPage2 }], captured)
    let calls = 0
    const onBatch = async () => {
      calls++
      throw new Error('R2 write timeout')
    }

    const result = await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      rowLimit: 2,
      onBatch,
    })

    expect(calls).toBe(1)
    expect(captured).toHaveLength(1) // loop stopped — did not fetch page 2
    expect(result.hasMore).toBe(true)
    expect(result.nextStartRow).toBe(0) // cursor NOT advanced past the unwritten page
  })

  it('rethrows a non-timeout (durable) onBatch failure instead of swallowing it', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([{ rows: fullPage2 }], captured)
    const onBatch = async () => {
      throw new Error('disk full')
    }

    await expect(runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      rowLimit: 2,
      onBatch,
    })).rejects.toThrow('disk full')
  })

  it('returns retry state without advancing the cursor when a GSC fetch times out', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = {
      _rawQuery: async (_siteUrl: string, body: SearchAnalyticsQuery) => {
        captured.push(body)
        throw Object.assign(new Error('socket aborted'), { name: 'AbortError' })
      },
    } as unknown as GoogleSearchConsoleClient

    const result = await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      initialStartRow: 40,
      onBatch: async () => {},
    })

    expect(result.hasMore).toBe(true)
    expect(result.nextStartRow).toBe(40)
    expect(result.totalRows).toBe(0)
  })

  it('scopes the slice to the registered host via a page-regex filter (ADR-0033)', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([{ rows: [] }], captured)

    await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      domainFilter: { domain: 'www.example.com' },
      onBatch: async () => {},
    })

    const groups = captured[0]!.dimensionFilterGroups
    expect(groups).toEqual([{
      filters: [{
        dimension: 'page',
        operator: 'includingRegex',
        expression: '^https?://(www\\.)?example\\.com/',
      }],
    }])
  })

  it('omits dimensionFilterGroups when no domainFilter is given', async () => {
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

    expect(captured[0]!.dimensionFilterGroups).toBeUndefined()
  })

  it('defaults searchType to web and forwards an explicit searchType to the query', async () => {
    const webCap: SearchAnalyticsQuery[] = []
    await runGscSyncSlice({
      client: makeClient([{ rows: [] }], webCap),
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      onBatch: async () => {},
    })
    expect(webCap[0]!.type).toBe('web')

    const discoverCap: SearchAnalyticsQuery[] = []
    await runGscSyncSlice({
      client: makeClient([{ rows: [] }], discoverCap),
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      searchType: 'discover',
      onBatch: async () => {},
    })
    expect(discoverCap[0]!.type).toBe('discover')
  })
})
