import type { GoogleSearchConsoleClient, SearchAnalyticsResponse } from 'gscdump'
import { describe, expect, it } from 'vitest'
import { runGscSyncSlice } from '../src/index'

function client(responses: SearchAnalyticsResponse[]): GoogleSearchConsoleClient {
  let cursor = 0
  return { searchAnalytics: { query: async () => responses[cursor++]! } } as unknown as GoogleSearchConsoleClient
}

const request = {
  siteUrl: 'sc-domain:example.test',
  table: 'pages' as const,
  startDate: '2026-09-05',
  endDate: '2026-09-05',
  domainFilter: { domain: 'www.example.test' },
}

describe('consumed Google pages at the durable outcome boundary', () => {
  it('records exact query and successful empty terminal response after physical writes', async () => {
    const events: Array<unknown> = []
    const row = { keys: ['https://www.example.test/a', '2026-09-05'], clicks: 2, impressions: 10, ctr: 0.2, position: 3 }
    await runGscSyncSlice({
      ...request,
      client: client([{ rows: [row] }, { rows: [] }]),
      onBatch: async () => { events.push('physical-commit') },
      onCommittedPage: async (outcome) => { events.push(outcome) },
    })
    expect(events).toEqual([
      'physical-commit',
      { siteUrl: request.siteUrl, request: expect.objectContaining({ startRow: 0, dimensions: ['page', 'date'], startDate: '2026-09-05', endDate: '2026-09-05', dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: expect.any(String) }] }] }), rows: [row], terminal: false, aggregation: 'byPage', metadata: undefined },
      { siteUrl: request.siteUrl, request: expect.objectContaining({ startRow: 1 }), rows: [], terminal: true, aggregation: 'byPage', metadata: undefined },
    ])
  })
  it('does not credit a consumed page when its physical commit times out', async () => {
    const outcomes: unknown[] = []
    const result = await runGscSyncSlice({
      ...request,
      maxPages: 1,
      client: client([{ rows: [{ keys: [], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }] }]),
      onBatch: async () => { throw new DOMException('Timed out', 'AbortError') },
      onCommittedPage: async (outcome) => { outcomes.push(outcome) },
    })
    expect(outcomes).toEqual([])
    expect(result).toMatchObject({ hasMore: true, nextStartRow: 0, totalRows: 0 })
  })
})

it('retains custom dimensions, user filters, property, search type and pagination in the consumed request', async () => {
  const outcomes: unknown[] = []
  await runGscSyncSlice({
    ...request,
    searchType: 'image',
    dimensions: ['query', 'device', 'date'],
    dimensionFilters: [{ dimension: 'country', operator: 'equals', expression: 'gbr' }],
    initialStartRow: 17,
    maxPages: 1,
    client: client([{ rows: [] }]),
    onBatch: async () => {},
    onCommittedPage: async (outcome) => { outcomes.push(outcome) },
  })
  expect(outcomes).toEqual([{ siteUrl: 'sc-domain:example.test', request: { startDate: '2026-09-05', endDate: '2026-09-05', dimensions: ['query', 'device', 'date'], rowLimit: 500, startRow: 17, dataState: 'all', type: 'image', dimensionFilterGroups: [{ filters: [
    { dimension: 'country', operator: 'equals', expression: 'gbr' },
    { dimension: 'page', operator: 'includingRegex', expression: '^https?://www\\.example\\.test/' },
  ] }] }, rows: [], terminal: true, aggregation: 'byPage', metadata: undefined }])
})

it('keeps a page cap separate from a provider terminal empty response', async () => {
  const outcomes: unknown[] = []
  const result = await runGscSyncSlice({
    ...request,
    maxPages: 1,
    client: client([{ rows: [{ keys: [], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }] }]),
    onBatch: async () => {},
    onCommittedPage: async (outcome) => { outcomes.push(outcome) },
  })
  expect(result).toMatchObject({ hasMore: true, nextStartRow: 1 })
  expect(outcomes).toEqual([expect.objectContaining({ terminal: false })])
})
