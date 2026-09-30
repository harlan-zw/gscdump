import { describe, expect, it, vi } from 'vitest'
import { indexNow } from '../../src/indexnow'

const key = 'abc12345'
const input = { host: 'example.com', key, keyLocation: `https://example.com/${key}.txt`, urls: ['https://example.com/page'] }

describe('indexNow client', () => {
  it.each([[200, 'accepted'], [202, 'pending'], [403, 'rejected'], [429, 'retrying'], [503, 'retrying']] as const)('maps %s to %s without claiming indexing', async (status, tag) => {
    const fetch = vi.fn(async () => new Response(null, { status, headers: { 'retry-after': '30' } }))
    const result = await indexNow({ fetch }).submit(input)
    expect(result).toMatchObject({ ok: true, value: { _tag: tag, httpStatus: status } })
    expect(fetch.mock.calls).toHaveLength(1)
  })
  it('sends the protocol request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    await indexNow({ fetch }).submit(input)
    expect(fetch).toHaveBeenCalledWith('https://api.indexnow.org/indexnow', expect.objectContaining({ method: 'POST', body: JSON.stringify({ host: input.host, key, keyLocation: input.keyLocation, urlList: input.urls }) }))
  })
  it.each(['https://evil.com/page', 'https://www.example.com/page', 'https://example.com:8080/page', 'ftp://example.com/page', 'https://user:pass@example.com/page'])('rejects outside-host URL %s before fetch', async (url) => {
    const fetch = vi.fn()
    expect(await indexNow({ fetch }).submit({ ...input, urls: [url] })).toMatchObject({ ok: false, error: { _tag: 'InvalidRequest' } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects URLs outside the key directory', async () => {
    expect(await indexNow({ fetch: vi.fn() }).submit({ ...input, keyLocation: 'https://example.com/blog/key.txt' })).toMatchObject({ ok: false, error: { _tag: 'InvalidRequest' } })
  })
  it('verifies only a bounded matching key file', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(`${key}\n`))
    expect(await indexNow({ fetch }).verify(input)).toEqual({ ok: true, value: { _tag: 'verified' } })
    expect(fetch).toHaveBeenCalledWith(input.keyLocation, expect.objectContaining({ redirect: 'error' }))
  })
  it.each([key.repeat(200), 'different'])('rejects oversized or mismatched key content', async (content) => {
    expect(await indexNow({ fetch: async () => new Response(content) }).verify(input)).toMatchObject({ ok: true, value: { _tag: 'verification-required' } })
  })
  it('preserves retry guidance from an HTTP date', async () => {
    const result = await indexNow({ fetch: async () => new Response(null, { status: 429, headers: { 'retry-after': 'Wed, 30 Sep 2026 00:00:30 GMT' } }), clock: () => new Date('2026-09-30T00:00:00.000Z') }).submit(input)
    expect(result).toMatchObject({ ok: true, value: { _tag: 'retrying', retryAfterMs: 30_000 } })
  })
  it('does not follow key file redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.redirect === 'error')
        throw new Error('redirect')
      return new Response(key)
    })
    await expect(indexNow({ fetch }).verify(input)).rejects.toThrow('redirect')
  })
  it('bounds a hanging key body with the request signal', async () => {
    const fetch: typeof globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    }))
    await expect(indexNow({ fetch, timeoutMs: 10 }).verify(input)).rejects.toThrow('aborted')
  })
  it('propagates infrastructure failures', async () => {
    await expect(indexNow({ fetch: async () => {
      throw new Error('network')
    } }).submit(input)).rejects.toThrow('network')
  })
})
