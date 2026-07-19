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
