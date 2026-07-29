import { describe, expect, it } from 'vitest'
import {
  canonicalSitemapIdentity,
  sameSitemapIdentity,
  scopeSitemapRecords,
  sitemapContentHash,
} from '../src/sitemap-identity'

describe('sitemap product identity', () => {
  it('canonicalizes relative records, excludes off-origin evidence, and keeps the newest duplicate', () => {
    const result = scopeSitemapRecords([
      { path: '/sitemap.xml', fetchedAt: 1 },
      { path: 'https://example.com/sitemap.xml#fragment', fetchedAt: 2 },
      { path: 'https://other.example/sitemap.xml', fetchedAt: 3 },
    ], 'sc-domain:example.com')
    expect(result).toEqual({
      sitemaps: [{ path: 'https://example.com/sitemap.xml', fetchedAt: 2 }],
      excludedCount: 1,
      duplicateCount: 1,
    })
    expect(canonicalSitemapIdentity('javascript:alert(1)', 'example.com'))
      .toEqual({ _tag: 'invalid', reason: 'invalid_url' })
    expect(canonicalSitemapIdentity('HTTP://ExAmPlE.com:80/a/../sitemap.xml#fragment'))
      .toEqual({ _tag: 'ok', url: 'http://example.com/sitemap.xml' })
    expect(canonicalSitemapIdentity('https://user:pass@example.com/sitemap.xml'))
      .toEqual({ _tag: 'invalid', reason: 'credentials' })
    expect(sameSitemapIdentity('/sitemap.xml', 'https://example.com/sitemap.xml', 'example.com')).toBe(true)
  })

  it('hashes the exact membership set without analytics normalization', async () => {
    const exact = await sitemapContentHash([
      { loc: 'https://www.example.com/Foo/?x=1' },
      { loc: 'https://example.com/foo' },
      { loc: 'https://example.com/foo' },
    ])
    const normalizedLookalike = await sitemapContentHash([
      { loc: 'https://example.com/foo' },
    ])
    expect(exact).toMatch(/^v1:[0-9a-f]{64}$/)
    expect(exact).not.toBe(normalizedLookalike)
  })
})
