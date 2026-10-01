import { between, date, gsc, page, query } from 'gscdump/query'
import { describe, expect, it, vi } from 'vitest'
import { createLiveGscSource } from '../src/live'

function emptyRows() {
  return (async function* () {
    yield []
  })()
}

describe('createLiveGscSource', () => {
  it('scopes searchType on BuilderState and reuses the host-created client', async () => {
    const states: Array<Record<string, unknown>> = []
    const client = {
      query: vi.fn((_siteUrl: string, builder: { getState: () => Record<string, unknown> }) => {
        states.push(builder.getState())
        return emptyRows()
      }),
    }
    const getAccessToken = vi.fn(async () => 'token')
    const createClient = vi.fn(() => client as any)
    const source = createLiveGscSource({
      siteUrl: 'sc-domain:example.com',
      getAccessToken,
      createClient,
      searchType: 'image',
    })

    const range = between(date, '2026-06-01', '2026-06-30')
    await source.queryRows(gsc.select(query).where(range).getState())
    await source.queryRows({ ...gsc.select(page).where(range).getState(), searchType: 'discover' })

    expect(states.map(state => state.searchType)).toEqual(['image', 'discover'])
    expect(getAccessToken).toHaveBeenCalledOnce()
    expect(createClient).toHaveBeenCalledOnce()
    expect(createClient).toHaveBeenCalledWith('token')
  })
})

describe('createLiveGscSource page scope', () => {
  function capture() {
    const states: Array<Record<string, unknown>> = []
    const client = {
      query: vi.fn((_siteUrl: string, builder: { getState: () => Record<string, unknown> }) => {
        states.push(builder.getState())
        return emptyRows()
      }),
    }
    return { states, createClient: () => client as any }
  }

  it('limits a scoped source to the registered host, like the sync', async () => {
    const { states, createClient } = capture()
    const source = createLiveGscSource({ siteUrl: 'sc-domain:example.com', getAccessToken: async () => 't', createClient, pageScope: { host: 'docs.example.com' } })

    await source.queryRows(gsc.select(query).where(between(date, '2026-06-01', '2026-06-30')).getState())

    expect(JSON.stringify(states[0]!.filter)).toContain('^https?://docs\\\\.example\\\\.com/')
  })

  it('sends no page filter without a scope', async () => {
    const { states, createClient } = capture()
    const source = createLiveGscSource({ siteUrl: 'sc-domain:example.com', getAccessToken: async () => 't', createClient })

    await source.queryRows(gsc.select(query).where(between(date, '2026-06-01', '2026-06-30')).getState())

    expect(JSON.stringify(states[0]!.filter)).not.toContain('includingRegex')
  })
})

describe('createLiveGscSource page scope composition', () => {
  function scoped() {
    const states: Array<Record<string, unknown>> = []
    const client = { query: vi.fn((_s: string, builder: { getState: () => Record<string, unknown> }) => {
      states.push(builder.getState())
      return emptyRows()
    }) }
    const source = createLiveGscSource({ siteUrl: 'sc-domain:example.com', getAccessToken: async () => 't', createClient: () => client as any, pageScope: { host: 'example.com' } })
    return { states, source }
  }

  it('keeps the caller filter and adds the scope', async () => {
    const { states, source } = scoped()
    await source.queryRows(gsc.select(query).where(between(date, '2026-06-01', '2026-06-30')).getState())

    const filter = JSON.stringify(states[0]!.filter)
    expect(filter).toContain('2026-06-01')
    expect(filter).toContain('includingRegex')
  })

  it('composes a wire-shaped filter instead of crashing', async () => {
    const { states, source } = scoped()
    const wire = { type: 'and', filters: [{ type: 'between', column: 'date', from: '2026-06-01', to: '2026-06-30' }] }
    await source.queryRows({ dimensions: ['query'], filter: wire } as any)

    expect(JSON.stringify(states[0]!.filter)).toContain('includingRegex')
  })

  it('rejects a malformed filter with the typed query error, not a crash', async () => {
    const { source } = scoped()

    await expect(source.queryRows({ dimensions: ['query'], filter: { type: 'and', filters: 'nope' } } as any)).rejects.toMatchObject({ queryError: { kind: 'invalid-filter' } })
  })

  it('rejects showcase counting under a page scope with a typed error', async () => {
    const { source } = scoped()
    const state = { ...gsc.select(query).where(between(date, '2026-06-01', '2026-06-30')).getState(), aggregationType: 'byNewsShowcasePanel' as const }

    await expect(source.queryRows(state)).rejects.toMatchObject({ queryError: { kind: 'invalid-aggregation-type' } })
  })

  it('rejects by-property counting under a page scope with a typed error', async () => {
    const { source } = scoped()
    const state = { ...gsc.select(query).where(between(date, '2026-06-01', '2026-06-30')).getState(), aggregationType: 'byProperty' as const }

    await expect(source.queryRows(state)).rejects.toMatchObject({ queryError: { kind: 'invalid-aggregation-type' } })
  })
})

// gscdump.com 2026-10-01: a Hosted read fell back to a host-scoped live source
// for `-d date` and returned no rows. Google applies the page scope itself; the
// rows it returns carry no `page` field to check the scope against again.
describe('createLiveGscSource page scope without a page dimension', () => {
  it('keeps the rows Google returns for a scoped date series', async () => {
    const days = [
      { date: '2026-09-27', clicks: 4, impressions: 40, ctr: 0.1, position: 5 },
      { date: '2026-09-28', clicks: 6, impressions: 50, ctr: 0.12, position: 4 },
    ]
    const client = { query: vi.fn(() => (async function* () {
      yield days
    })()) }
    const source = createLiveGscSource({ siteUrl: 'sc-domain:example.com', getAccessToken: async () => 't', createClient: () => client as any, pageScope: { host: 'example.com' } })

    const rows = await source.queryRows(gsc.select(date).where(between(date, '2026-09-27', '2026-09-28')).getState())

    expect(rows.map(row => row.date).sort()).toEqual(['2026-09-27', '2026-09-28'])
  })
})
