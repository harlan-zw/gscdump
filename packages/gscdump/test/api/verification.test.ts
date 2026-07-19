import { describe, expect, it } from 'vitest'
import { resolveVerificationTarget } from '../../src/api/verification'

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
