import { describe, expect, it } from 'vitest'
import { classifyCanonicalDifference, isCanonicalMismatch } from '../src/core/canonical'

describe('classifyCanonicalDifference', () => {
  it('returns none when either side is absent', () => {
    // The existing SQL predicate guards on both-non-null; keep that meaning.
    expect(classifyCanonicalDifference(null, 'https://x.com/a')).toBe('none')
    expect(classifyCanonicalDifference('https://x.com/a', null)).toBe('none')
    expect(classifyCanonicalDifference('', 'https://x.com/a')).toBe('none')
    expect(classifyCanonicalDifference(null, null)).toBe('none')
  })

  it('returns none for byte-identical canonicals', () => {
    expect(classifyCanonicalDifference('https://x.com/a', 'https://x.com/a')).toBe('none')
  })

  it('classifies trailing-slash-only differences as formatting', () => {
    // Measured on production: 2 of nuxtseo.com's 5 "mismatches", and 6 of 6 on
    // codingoblin.com, differ only by a trailing slash.
    expect(classifyCanonicalDifference('https://x.com/a', 'https://x.com/a/')).toBe('formatting')
    expect(classifyCanonicalDifference('https://x.com/a/', 'https://x.com/a')).toBe('formatting')
  })

  it('classifies scheme, www and host-case differences as formatting', () => {
    expect(classifyCanonicalDifference('http://x.com/a', 'https://x.com/a')).toBe('formatting')
    expect(classifyCanonicalDifference('https://www.x.com/a', 'https://x.com/a')).toBe('formatting')
    // D1 columns are plain TEXT with no COLLATE NOCASE, so host case reaches here.
    expect(classifyCanonicalDifference('https://X.COM/a', 'https://x.com/a')).toBe('formatting')
    expect(classifyCanonicalDifference('https://WWW.X.com/a/', 'http://x.com/a')).toBe('formatting')
  })

  it('keeps PATH case significant — paths are case-sensitive on most servers', () => {
    expect(classifyCanonicalDifference('https://x.com/A', 'https://x.com/a')).toBe('path')
  })

  it('classifies a genuine path difference as path', () => {
    expect(classifyCanonicalDifference(
      'https://nuxtseo.com/docs/sitemap/advanced/performance',
      'https://nuxtseo.com/sitemap/guides/cache',
    )).toBe('path')
    // The real nuxtseo.com bug: a docs page canonicalising to the login screen.
    expect(classifyCanonicalDifference(
      'https://nuxtseo.com/pro/dashboard/login',
      'https://nuxtseo.com/docs/nuxt-seo-pro/mcp/dev-assist-tools',
    )).toBe('path')
  })

  it('classifies a different host as cross_domain, not path', () => {
    // Syndication, hijack or a botched migration. Today this carries the same
    // severity and label as a trailing slash; it must be separable.
    expect(classifyCanonicalDifference('https://other.com/a', 'https://x.com/a')).toBe('cross_domain')
    expect(classifyCanonicalDifference('https://sub.x.com/a', 'https://x.com/a')).toBe('cross_domain')
  })

  it('treats a query-string difference as path, not formatting', () => {
    // A query string can select genuinely different content; do not normalise
    // it away. Only same-resource spellings count as formatting.
    expect(classifyCanonicalDifference('https://x.com/a?p=1', 'https://x.com/a')).toBe('path')
  })

  it('does not throw on unparseable input', () => {
    // Google returns these verbatim; never let a malformed value break ingest.
    expect(classifyCanonicalDifference('not a url', 'https://x.com/a')).toBe('path')
    expect(classifyCanonicalDifference('not a url', 'not a url')).toBe('none')
  })
})

describe('isCanonicalMismatch', () => {
  it('reports only differences worth acting on', () => {
    // Headline counters use this; formatting noise must not inflate them.
    expect(isCanonicalMismatch('https://x.com/a', 'https://x.com/a/')).toBe(false)
    expect(isCanonicalMismatch('https://x.com/a', 'https://x.com/b')).toBe(true)
    expect(isCanonicalMismatch('https://other.com/a', 'https://x.com/a')).toBe(true)
    expect(isCanonicalMismatch(null, 'https://x.com/a')).toBe(false)
  })

  it('agrees with the classifier it wraps', () => {
    const cases: Array<[string | null, string | null]> = [
      ['https://x.com/a', 'https://x.com/a/'],
      ['https://x.com/a', 'https://x.com/b'],
      ['https://other.com/a', 'https://x.com/a'],
      [null, 'https://x.com/a'],
    ]
    for (const [u, g] of cases) {
      const kind = classifyCanonicalDifference(u, g)
      expect(isCanonicalMismatch(u, g)).toBe(kind === 'path' || kind === 'cross_domain')
    }
  })
})
