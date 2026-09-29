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
