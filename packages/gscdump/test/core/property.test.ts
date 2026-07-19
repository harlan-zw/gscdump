import { describe, expect, it } from 'vitest'
import { pickBestGscProperty } from '../../src/core/property'

const OWNER = 'siteOwner'

describe('pickBestGscProperty', () => {
  it('prefers a verified domain property over URL-prefix variants', () => {
    const picked = pickBestGscProperty('https://example.com', [
      { siteUrl: 'http://example.com/', permissionLevel: OWNER },
      { siteUrl: 'https://example.com/', permissionLevel: OWNER },
      { siteUrl: 'sc-domain:example.com', permissionLevel: OWNER },
    ])
    expect(picked?.siteUrl).toBe('sc-domain:example.com')
  })

  it('prefers HTTPS over HTTP when no domain property exists', () => {
    const picked = pickBestGscProperty('https://example.com', [
      { siteUrl: 'http://example.com/', permissionLevel: OWNER },
      { siteUrl: 'https://example.com/', permissionLevel: OWNER },
    ])
    expect(picked?.siteUrl).toBe('https://example.com/')
  })

  it('prefers an exact subdomain property over a parent domain property', () => {
    const picked = pickBestGscProperty('https://docs.example.com', [
      { siteUrl: 'sc-domain:example.com', permissionLevel: OWNER },
      { siteUrl: 'sc-domain:docs.example.com', permissionLevel: OWNER },
    ])
    expect(picked?.siteUrl).toBe('sc-domain:docs.example.com')
  })
})
