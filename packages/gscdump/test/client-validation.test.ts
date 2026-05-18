import { describe, expect, it, vi } from 'vitest'
import { googleSearchConsole } from '../src'

describe('sites.add URL validation', () => {
  const mkClient = () => {
    const fetch = vi.fn().mockResolvedValue(undefined)
    return { client: googleSearchConsole('t', { fetch: fetch as any }), fetch }
  }

  it('accepts URL-prefix properties', async () => {
    const { client, fetch } = mkClient()
    await client.sites.add('https://example.com/')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('accepts sc-domain properties', async () => {
    const { client, fetch } = mkClient()
    await client.sites.add('sc-domain:example.com')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects plain hostnames', () => {
    const { client, fetch } = mkClient()
    expect(() => client.sites.add('example.com')).toThrow(/Invalid siteUrl/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects empty sc-domain prefix', () => {
    const { client } = mkClient()
    expect(() => client.sites.add('sc-domain:')).toThrow(/Invalid siteUrl/)
  })
})
