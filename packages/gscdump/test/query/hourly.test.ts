import { describe, expect, it, vi } from 'vitest'
import { googleSearchConsole } from '../../src'
import { gsc } from '../../src/query/builder'
import { date, hour, page } from '../../src/query/columns'
import { between } from '../../src/query/operators'
import { normalizeBuilderState, resolveToBody } from '../../src/query/resolver'

describe('hourly Discover support', () => {
  describe('builder', () => {
    it('selects hour dimension', () => {
      const body = gsc
        .select(date, hour, page)
        .where(between(date, '2026-05-17', '2026-05-18'))
        .dataState('hourly_all')
        .toBody()

      expect(body.dimensions).toEqual(['date', 'hour', 'page'])
      expect(body.dataState).toBe('hourly_all')
    })

    it('omits dataState by default', () => {
      const body = gsc
        .select(page)
        .where(between(date, '2026-05-17', '2026-05-18'))
        .toBody()

      expect(body.dataState).toBeUndefined()
    })

    it('threads dataState through getState', () => {
      const state = gsc
        .select(date)
        .where(between(date, '2026-05-17', '2026-05-18'))
        .dataState('all')
        .getState()

      expect(state.dataState).toBe('all')
    })

    it('round-trips through normalizeBuilderState', () => {
      const state = gsc
        .select(hour)
        .where(between(date, '2026-05-17', '2026-05-18'))
        .dataState('hourly_all')
        .getState()

      const normalized = normalizeBuilderState(JSON.parse(JSON.stringify(state)))
      expect(normalized.dataState).toBe('hourly_all')
      expect(resolveToBody(normalized).dataState).toBe('hourly_all')
    })
  })

  describe('client.query metadata', () => {
    it('returns first_incomplete_hour as the generator final value', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        rows: [
          { keys: ['2026-05-18T11:00:00-07:00'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.1 },
        ],
        metadata: {
          first_incomplete_hour: '2026-05-18T11:00:00-07:00',
        },
      })

      const client = googleSearchConsole('test-token', { fetch: mockFetch as any })
      const builder = gsc
        .select(hour)
        .where(between(date, '2026-05-17', '2026-05-18'))
        .dataState('hourly_all')

      const it = client.query('https://example.com/', builder)
      const batches: any[] = []
      let result = await it.next()
      while (!result.done) {
        batches.push(result.value)
        result = await it.next()
      }

      expect(batches).toHaveLength(1)
      expect(batches[0][0]).toMatchObject({ hour: '2026-05-18T11:00:00-07:00', clicks: 5 })
      expect(result.value).toEqual({ first_incomplete_hour: '2026-05-18T11:00:00-07:00' })
    })

    it('returns undefined metadata when response omits it', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        rows: [{ keys: ['/foo'], clicks: 1, impressions: 1, ctr: 1, position: 1 }],
      })

      const client = googleSearchConsole('test-token', { fetch: mockFetch as any })
      const builder = gsc.select(page).where(between(date, '2026-05-17', '2026-05-18'))

      const it = client.query('https://example.com/', builder)
      let result = await it.next()
      while (!result.done)
        result = await it.next()

      expect(result.value).toBeUndefined()
    })

    it('sends dataState in the request body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ rows: [] })
      const client = googleSearchConsole('test-token', { fetch: mockFetch as any })

      const it = client.query(
        'https://example.com/',
        gsc.select(hour).where(between(date, '2026-05-17', '2026-05-18')).dataState('hourly_all'),
      )
      let r = await it.next()
      while (!r.done) r = await it.next()

      const sentBody = mockFetch.mock.calls[0][1].body
      expect(sentBody.dataState).toBe('hourly_all')
      expect(sentBody.dimensions).toEqual(['hour'])
    })
  })
})
