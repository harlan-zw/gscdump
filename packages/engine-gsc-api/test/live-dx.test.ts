import type { GoogleSearchConsoleClient } from 'gscdump'
import { and, between, clicks, date, eq, gsc, gte, or, query, queryCanonical } from 'gscdump/query'
import { describe, expect, it, vi } from 'vitest'
import { canProxyToGsc, createGscApiQuerySource, createLiveGscSource } from '../src'

const range = between(date, '2026-06-01', '2026-06-30')

describe('live Source recovery and routing', () => {
  it.each(['token', 'client'] as const)('retries failed %s setup on the next query', async (stage) => {
    const failure = new Error('temporary setup failure')
    const rows = [{ query: 'healthy', clicks: 1, impressions: 10, ctr: 0.1, position: 2 }]
    const client = { async* query() {
      yield rows
    } } as unknown as GoogleSearchConsoleClient
    const getAccessToken = vi.fn().mockResolvedValue('fresh-token')
    const createClient = vi.fn().mockResolvedValue(client)
    if (stage === 'token')
      getAccessToken.mockRejectedValueOnce(failure)
    else
      createClient.mockRejectedValueOnce(failure)
    const source = createLiveGscSource({ siteUrl: 'sc-domain:example.com', getAccessToken, createClient })
    const state = gsc.select(query).where(range).getState()

    const failures = await Promise.allSettled([source.queryRows(state), source.queryRows(state)])
    expect(failures).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    await expect(source.queryRows(state)).resolves.toEqual(rows)
    expect(getAccessToken).toHaveBeenCalledTimes(2)
  })

  it.each([
    and(range, eq(queryCanonical, 'canonical')),
    and(range, or(eq(query, 'raw'), eq(queryCanonical, 'canonical'))),
  ])('keeps Engine-derived filters away from live routing', (filter) => {
    expect(canProxyToGsc(gsc.select(query).where(filter).getState())).toBe(false)
  })
})

describe('live Source prefilters', () => {
  it.each([gte(clicks, 10), eq(queryCanonical, 'canonical')])('rejects unsupported prefilters before querying Google', async (prefilter) => {
    const queryClient = vi.fn(async function* () {
      yield []
    })
    const client = { query: queryClient } as unknown as GoogleSearchConsoleClient
    const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })
    const state = gsc.select(query).where(range).prefilter(prefilter).getState()
    expect(canProxyToGsc(state)).toBe(false)
    await expect(source.queryRows(state)).rejects.toMatchObject({
      queryError: { kind: 'unsupported-capability', capability: 'prefilter' },
    })
    expect(queryClient).not.toHaveBeenCalled()
  })
})
