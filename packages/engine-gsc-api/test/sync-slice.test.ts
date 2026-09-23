import type { GoogleSearchConsoleClient, SearchAnalyticsQuery, SearchAnalyticsResponse } from 'gscdump'
import type { GscApiRow } from '../src/sync-slice'
import { describe, expect, it } from 'vitest'
import { runGscSearchAppearanceContextSlice, runGscSyncSlice } from '../src/sync-slice'

function makeClient(
  responses: SearchAnalyticsResponse[],
  capturedQueries: SearchAnalyticsQuery[],
): GoogleSearchConsoleClient {
  let i = 0
  return {
    searchAnalytics: {
      query: async (_siteUrl: string, body: SearchAnalyticsQuery) => {
        capturedQueries.push(body)
        const r = responses[i] ?? { rows: [] }
        i++
        return r
      },
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
    expect(captured[0]!.dataState).toBe('hourly_all')
  })

  it('defaults search_appearance dimensions to searchAppearance only', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([{ rows: [] }], captured)

    await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'search_appearance',
      startDate: '2026-05-10',
      endDate: '2026-05-10',
      onBatch: async () => {},
    })

    expect(captured[0]!.dimensions).toEqual(['searchAppearance'])
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

    expect(calls).toBe(1) // page 2's write never runs — we stopped after page 1 timed out
    // Pipelining prefetches page 2 before page 1's write resolves, so page 2 IS
    // fetched, then discarded when the write times out (the prefetch promise
    // never rejects, so the discard is safe). The cursor still returns to page 1
    // — no silent gap — and the continuation re-fetches + re-writes it.
    expect(captured).toHaveLength(2)
    expect(result.hasMore).toBe(true)
    expect(result.nextStartRow).toBe(0) // cursor NOT advanced past the unwritten page
  })

  it('pipelines: fetches the next page while the current write is in flight, preserving order', async () => {
    const onePartialRow = [{ keys: ['x'], clicks: 1, impressions: 1, ctr: 1, position: 1 }]
    const captured: SearchAnalyticsQuery[] = []
    // page1 full, page2 full, page3 partial, page4 empty (terminates the slice).
    const client = makeClient([{ rows: fullPage2 }, { rows: fullPage2 }, { rows: onePartialRow }, { rows: [] }], captured)

    const events: string[] = []
    let releaseWrite1!: () => void
    const write1Gate = new Promise<void>((resolve) => {
      releaseWrite1 = resolve
    })
    let batchN = 0
    const onBatch = async () => {
      const n = ++batchN
      events.push(`write${n}:start`)
      if (n === 1)
        await write1Gate // hold page 1's write open so we can observe the prefetch
      events.push(`write${n}:end`)
    }

    const slicePromise = runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      rowLimit: 2,
      onBatch,
    })

    // Flush microtasks: page 1 fetched, its write started + pending, page 2 prefetched.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(captured).toHaveLength(2) // page 2 fetched WHILE page 1's write is still pending
    expect(events).toEqual(['write1:start']) // write 1 has not resolved yet

    releaseWrite1()
    const result = await slicePromise

    expect(result.hasMore).toBe(false)
    expect(captured).toHaveLength(4)
    expect(captured.map(q => q.startRow)).toEqual([0, 2, 4, 5]) // cursors paged in order
    expect(events).toEqual([
      'write1:start',
      'write1:end',
      'write2:start',
      'write2:end',
      'write3:start',
      'write3:end',
    ]) // writes applied strictly in page order despite the prefetch
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
      searchAnalytics: {
        query: async (_siteUrl: string, body: SearchAnalyticsQuery) => {
          captured.push(body)
          throw Object.assign(new Error('socket aborted'), { name: 'AbortError' })
        },
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

  it('continues after short non-empty pages until an empty page', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([
      { rows: [{ keys: ['a'], clicks: 1, impressions: 1, ctr: 1, position: 1 }] },
      { rows: [{ keys: ['b'], clicks: 1, impressions: 1, ctr: 1, position: 1 }] },
      { rows: [] },
    ], captured)
    const batches: GscApiRow[][] = []

    const result = await runGscSyncSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      table: 'pages',
      startDate: '2026-05-10',
      endDate: '2026-05-17',
      rowLimit: 2,
      onBatch: async rows => batches.push(rows),
    })

    expect(result.hasMore).toBe(false)
    expect(result.totalRows).toBe(2)
    expect(result.nextStartRow).toBe(2)
    expect(captured.map(q => q.startRow)).toEqual([0, 1, 2])
    expect(batches).toHaveLength(2)
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

  it('runs the two-step search appearance context flow', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([
      { rows: [{ keys: ['AMP_BLUE_LINK'], clicks: 3, impressions: 30, ctr: 0.1, position: 2 }] },
      { rows: [] },
      { rows: [{ keys: ['https://example.com/a', 'blue widgets', '2026-05-10'], clicks: 1, impressions: 10, ctr: 0.1, position: 2 }] },
    ], captured)
    const contextRows: Array<{ searchAppearance: string, table: string, rows: GscApiRow[] }> = []

    const result = await runGscSearchAppearanceContextSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-05-10',
      endDate: '2026-05-10',
      onContextBatch: async batch => contextRows.push(batch),
    })

    expect(result.appearances).toEqual(['AMP_BLUE_LINK'])
    expect(captured[0]!.dimensions).toEqual(['searchAppearance'])
    expect(captured[1]!.dimensions).toEqual(['searchAppearance'])
    expect(captured[2]!.dimensions).toEqual(['page', 'query', 'date'])
    expect(contextRows[0]!.table).toBe('search_appearance_page_queries')
    expect(captured[2]!.dimensionFilterGroups).toEqual([{
      filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: 'AMP_BLUE_LINK' }],
    }])
    expect(contextRows[0]!.searchAppearance).toBe('AMP_BLUE_LINK')
    expect(contextRows[0]!.rows).toHaveLength(1)
  })

  it('surfaces the context slices\' metadata so hosts can track incomplete days', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([
      { rows: [{ keys: ['AMP_BLUE_LINK'], clicks: 3, impressions: 30, ctr: 0.1, position: 2 }], metadata: { first_incomplete_hour: 'DISCOVERY' } } as unknown as SearchAnalyticsResponse,
      { rows: [] },
      { rows: [{ keys: ['https://example.com/a', '2026-05-10'], clicks: 1, impressions: 10, ctr: 0.1, position: 2 }], metadata: { first_incomplete_hour: '2026-05-10T15:00:00-07:00' } } as unknown as SearchAnalyticsResponse,
    ], captured)

    const result = await runGscSearchAppearanceContextSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-05-10',
      endDate: '2026-05-10',
      table: 'search_appearance_pages',
      onContextBatch: async () => {},
    })

    expect(result.metadata?.first_incomplete_hour).toBe('2026-05-10T15:00:00-07:00')
    expect(result.hasMore).toBe(false)
  })

  it('returns a resumable continuation for partial search appearance discovery', async () => {
    const captured: SearchAnalyticsQuery[] = []
    const client = makeClient([
      { rows: [{ keys: ['AMP_BLUE_LINK'], clicks: 3, impressions: 30, ctr: 0.1, position: 2 }] },
      { rows: [{ keys: ['WEB_LIGHT_RESULT'], clicks: 2, impressions: 20, ctr: 0.1, position: 3 }] },
      { rows: [] },
    ], captured)

    const first = await runGscSearchAppearanceContextSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-05-10',
      endDate: '2026-05-10',
      rowLimit: 1,
      maxPages: 1,
      onContextBatch: async () => {},
    })

    expect(first.hasMore).toBe(true)
    expect(first.continuation).toEqual({
      phase: 'discovery',
      appearances: ['AMP_BLUE_LINK'],
      nextStartRow: 1,
    })

    const second = await runGscSearchAppearanceContextSlice({
      client,
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-05-10',
      endDate: '2026-05-10',
      rowLimit: 1,
      maxPages: 1,
      continuation: first.continuation,
      onContextBatch: async () => {},
    })

    expect(second.continuation).toMatchObject({
      phase: 'discovery',
      appearances: ['AMP_BLUE_LINK', 'WEB_LIGHT_RESULT'],
      nextStartRow: 2,
    })
    expect(captured.map(q => q.startRow)).toEqual([0, 1])
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
