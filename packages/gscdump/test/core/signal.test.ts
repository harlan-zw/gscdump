import type { ofetch } from 'ofetch'
import { describe, expect, it } from 'vitest'
import { googleSearchConsole } from '../../src/core/client'
import { between, date, gsc, page } from '../../src/query'

function makeStubFetch(handler: (url: string, init: { body?: unknown, signal?: AbortSignal }) => unknown): typeof ofetch {
  const stub = (async (url: string, init: { body?: unknown, signal?: AbortSignal } = {}) => handler(url, init)) as unknown as typeof ofetch
  ;(stub as any).create = () => stub
  return stub
}

describe('abortSignal threading', () => {
  it('passes signal to the underlying fetch on sites()', async () => {
    let captured: AbortSignal | undefined
    const fetch = makeStubFetch((_url, init) => {
      captured = init.signal
      return { siteEntry: [] }
    })
    const controller = new AbortController()
    const client = googleSearchConsole('tok', { fetch })
    await client.sites({ signal: controller.signal })
    expect(captured).toBe(controller.signal)
  })

  it('throws AbortError before the first query page when signal is already aborted', async () => {
    const fetch = makeStubFetch(() => ({ rows: [] }))
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    const client = googleSearchConsole('tok', { fetch })
    const builder = gsc.select(page).where(between(date, '2026-04-01', '2026-04-10'))
    const iter = client.query('sc-domain:example.com', builder, { signal: controller.signal })
    await expect(iter.next()).rejects.toThrow('cancelled')
  })

  it('passes signal to inspect()', async () => {
    let captured: AbortSignal | undefined
    const fetch = makeStubFetch((_url, init) => {
      captured = init.signal
      return { inspectionResult: {} }
    })
    const controller = new AbortController()
    const client = googleSearchConsole('tok', { fetch })
    await client.inspect('sc-domain:example.com', 'https://example.com/', { signal: controller.signal })
    expect(captured).toBe(controller.signal)
  })
})
