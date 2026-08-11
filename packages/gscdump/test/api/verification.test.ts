import { describe, expect, it, vi } from 'vitest'
import { resolveVerificationTarget } from '../../src/api/verification'
import { googleSearchConsole } from '../../src/core/client'

describe('resolveVerificationTarget', () => {
  it('defaults URL-prefix properties to META', () => {
    expect(resolveVerificationTarget('https://www.example.com/path')).toEqual({
      site: { type: 'SITE', identifier: 'https://www.example.com/' },
      method: 'META',
    })
  })

  it('allows URL-prefix properties to use DNS', () => {
    expect(resolveVerificationTarget('https://www.example.com/path', 'DNS_TXT')).toEqual({
      site: { type: 'INET_DOMAIN', identifier: 'www.example.com' },
      method: 'DNS_TXT',
    })
  })

  it('coerces URL-only methods for domain properties to DNS_TXT', () => {
    expect(resolveVerificationTarget('sc-domain:example.com', 'META')).toEqual({
      site: { type: 'INET_DOMAIN', identifier: 'example.com' },
      method: 'DNS_TXT',
    })
  })
})

describe('Site Verification resource updates', () => {
  it.each([
    ['patch', 'PATCH'],
    ['update', 'PUT'],
  ] as const)('supports %s', async (operation, method) => {
    const resource = {
      id: 'https://example.com/',
      site: { type: 'SITE' as const, identifier: 'https://example.com/' },
      owners: ['owner@example.com'],
    }
    const fetch = vi.fn().mockResolvedValue(resource)
    const client = googleSearchConsole('token', { fetch: fetch as any })

    await expect(client.verification[operation]('https://example.com/', resource)).resolves.toEqual(resource)
    expect(fetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/siteVerification/v1/webResource/https%3A%2F%2Fexample.com%2F',
      expect.objectContaining({ method, body: resource }),
    )
  })
})
