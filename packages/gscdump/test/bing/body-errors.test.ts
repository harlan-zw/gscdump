import { describe, expect, it } from 'vitest'
import { bingWebmaster } from '../../src/bing'

describe('bing response body failures', () => {
  it.each([new DOMException('cancelled', 'AbortError'), new TypeError('connection reset')])('preserves body read failure %s', async (cause) => {
    const client = bingWebmaster({
      accessToken: 'token',
      fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(cause) } })),
    })
    await expect(client.getUserSites()).rejects.toBe(cause)
  })

  it('still classifies invalid JSON as a malformed response', async () => {
    const client = bingWebmaster({ accessToken: 'token', fetch: async () => new Response('{') })
    await expect(client.getUserSites()).resolves.toMatchObject({
      ok: false,
      error: { _tag: 'MalformedResponse', reason: 'invalid-json' },
    })
  })
})
